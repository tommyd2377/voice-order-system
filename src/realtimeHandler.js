import WebSocket, { WebSocketServer } from 'ws';
import { createRequire } from 'module';
import { connectGeminiLive } from './geminiLiveClient.js';

const require = createRequire(import.meta.url);
const admin = require('firebase-admin');
let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  // Hosted (Railway, etc): JSON string from env var
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  console.log('[Firebase] (realtimeHandler) Using service account from FIREBASE_SERVICE_ACCOUNT_JSON env var');
} else {
  // Local dev: use the ignored file if you want to have one again
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  serviceAccount = require('../serviceAccountKey.json');
  console.log('[Firebase] (realtimeHandler) Using local serviceAccountKey.json');
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: 'voice-order-react',
  });
}

const db = admin.firestore();
const VERBOSE_GEMINI_LOGS = process.env.VERBOSE_GEMINI_LOGS === 'true';
const DEFAULT_AUDIO_MIME_TYPE = 'audio/pcm;rate=8000';
const BASE_INSTRUCTIONS = `
You are the automated phone ordering assistant for {{RESTAURANT_NAME}}, a {{RESTAURANT_DESCRIPTION}}. You answer calls, take food orders, and enter them accurately into the system.

GLOBAL STYLE
- Be concise and transactional; keep turns short.
- Use simple, natural language, not corporate or robotic.
- Ask only for information needed to place the order.
- No small talk, no jokes, no stories.
- Never explain that you are an AI unless the caller directly asks.

CALL OPENING (DO THIS ONCE AT THE VERY START)
At the beginning of the call, before asking anything else, say exactly:
"Thanks for calling {{RESTAURANT_NAME}}. I'm the automated assistant. Are you ordering for pickup or delivery?"
Then stop and wait for the caller's answer.
Do not repeat this greeting later in the call.

CALL FLOW
1. Determine pickup vs delivery.
   - For pickup: ask for the customer's name and phone number at some natural point early in the call.
   - For delivery: ask for name, phone number, and full delivery address (including apartment/floor if needed). If any address detail is unclear, ask a short follow-up question.

2. Take the order items.
   - Ask what they'd like to order.
   - Capture each item's name, quantity, and any options or notes (sauce, spice level, sides, etc.).
   - If something is ambiguous, ask a brief clarifying question.
   - Keep each response to 1-2 short sentences.

3. Confirm the order.
   - Read back a compact summary: items, pickup vs delivery, and any key notes.
   - If there is a total price provided to you, confirm it; if not, do NOT invent prices.
   - Ask "Is everything correct?" and wait for the caller to confirm or correct.

TOOL USE: submit_order
- When the order is fully confirmed and you have:
  - customer name
  - customer phone
  - fulfillment type (pickup or delivery)
  - delivery address for delivery orders
  - all items with quantities and notes
- Then call the submit_order tool exactly once with the final data.
- Do not call submit_order before the order is confirmed.
- Do not call submit_order multiple times unless the caller clearly places a second, separate order.

AFTER TOOL CALL
- After the tool responds, give ONE short confirmation sentence such as:
  "Your pickup order for [brief summary] is placed. It'll be ready in about [time if known or given]."
- For delivery: "Your delivery order to [street or landmark only, not full address] is placed."
- Do not ask new questions after the final confirmation.
- End the call politely and succinctly, e.g., "Thank you for calling {{RESTAURANT_NAME}}."
`.trim();
const SUBMIT_ORDER_TOOL = {
  name: 'submit_order',
  description: 'Submit a confirmed order from this phone call.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      customerName: { type: 'string' },
      customerPhone: { type: 'string' },
      fulfillmentType: { type: 'string', enum: ['pickup', 'delivery'] },
      deliveryAddress: {
        type: 'string',
        description: 'Full delivery street address including number and street name.',
      },
      deliveryApt: {
        type: 'string',
        description: 'Apartment, unit, or floor, if applicable.',
        nullable: true,
      },
      deliveryNotes: {
        type: 'string',
        description: 'Extra delivery notes or landmark info.',
        nullable: true,
      },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            quantity: { type: 'number' },
            notes: { type: 'string' },
          },
          required: ['name', 'quantity'],
          additionalProperties: false,
        },
      },
      notes: { type: 'string' },
    },
    required: ['customerName', 'customerPhone', 'fulfillmentType', 'items'],
    additionalProperties: false,
  },
};


export function attachRealtimeServer(server) {
  const wss = new WebSocketServer({ server, path: '/realtime' });

  wss.on('listening', () => {
    console.log('Realtime WebSocket server ready at /realtime');
  });

  wss.on('connection', (socket, request) => {
    const callSid = request.headers['x-twilio-call-sid'];
    console.log('Twilio stream connected');
    console.log(`[Realtime] Twilio stream connected${callSid ? ` for CallSid=${callSid}` : ''}`);

    let currentRestaurant = null;

    const loadRestaurantById = async (restaurantIdParam) => {
      if (!restaurantIdParam) {
        return null;
      }
      try {
        const snap = await db.collection('restaurants').doc(restaurantIdParam).get();
        if (!snap.exists) {
          console.error('[Realtime] restaurantId not found in Firestore', {
            restaurantId: restaurantIdParam,
          });
          return null;
        }

        currentRestaurant = { id: snap.id, restaurantId: snap.id, ...snap.data() };
        console.log('[Realtime] restaurant loaded for call', {
          restaurantId: snap.id,
          name: currentRestaurant.name,
        });
        return currentRestaurant;
      } catch (err) {
        console.error('[Realtime] failed to fetch restaurant for connection', err);
        return null;
      }
    };

    let restaurantReady = (async () => {
      try {
        const requestUrl = new URL(request.url, 'http://localhost');
        const restaurantIdParam = requestUrl.searchParams.get('restaurantId');
        if (restaurantIdParam) {
          return await loadRestaurantById(restaurantIdParam);
        }
        console.warn('[Realtime] no restaurantId query param on WebSocket connection; waiting for start event');
        return null;
      } catch (err) {
        console.error('[Realtime] failed to parse connection URL for restaurantId', err);
        return null;
      }
    })();

    let streamSid = null;
    let userSpeaking = false;
    let lastSubmitOrderPayload = null;
    let submitOrderCount = 0;
    let orderSubmitted = false;
    let assistantTextBuffer = '';
    let geminiClient = null;
    let geminiClientPromise = null;
    const orderLog = [];

    const handleBargeIn = async () => {
      userSpeaking = true;

      if (streamSid && socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(
            JSON.stringify({
              event: 'clear',
              streamSid,
            })
          );
          console.log('[Realtime] sent clear event to Twilio');
        } catch (err) {
          console.warn('[Realtime] failed to send clear event to Twilio', err);
        }
      }

      try {
        const client = geminiClient || (await geminiClientPromise);
        client?.cancelResponse();
      } catch (err) {
        console.warn('[Gemini] failed to cancel active response', err);
      }
    };

    const wireGeminiEvents = (client) => {
      client.on('user.start', () => {
        handleBargeIn();
      });

      client.on('audio.delta', ({ chunk }) => {
        if (!chunk || !streamSid) return;
        if (userSpeaking) return;
        userSpeaking = false;
        const twilioMedia = {
          event: 'media',
          streamSid,
          media: { payload: chunk },
        };
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(twilioMedia));
        }
      });

      client.on('text.delta', ({ text }) => {
        if (text) {
          assistantTextBuffer += text;
        }
      });

      client.on('text.done', ({ text }) => {
        const finalText = (text || assistantTextBuffer || '').trim();
        if (finalText) {
          orderLog.push({ from: 'assistant', text: finalText });
        }
        assistantTextBuffer = '';
      });

      client.on('response.complete', () => {});

      client.on('response.interrupted', () => {});

      client.on('transcript.completed', ({ text }) => {
        if (text) {
          orderLog.push({ from: 'user', text: String(text) });
        }
      });

      client.on('tool.call', async ({ name, callId, argumentsJsonString }) => {
        if (name !== 'submit_order') {
          return;
        }
        try {
          await restaurantReady;
          const payload = JSON.parse(argumentsJsonString || '{}');
          lastSubmitOrderPayload = payload;
          submitOrderCount += 1;
          console.log('[Order Tool Payload]', JSON.stringify(payload, null, 2));
          if (!currentRestaurant) {
            console.error('[Order Tool Payload] missing restaurant context; skipping Firestore write');
          }

          if (callId) {
            client.sendToolResponse({
              callId,
              name,
              response: payload,
            });
          }

          const confirmationText = `Confirm once in a single short sentence the ${
            payload.fulfillmentType || 'pickup'
          } order is placed${payload.deliveryAddress ? ` to ${payload.deliveryAddress}` : ''}. No extra questions.`;
          client.sendTextPrompt(confirmationText);
        } catch (err) {
          console.warn('[Order Tool Payload] failed to parse arguments', err);
        }
      });

      client.on('error', (err) => {
        console.error('[Gemini] error event payload:', err);
      });
    };

    const initializeGemini = async () => {
      try {
        await restaurantReady;
        const restaurantName = currentRestaurant?.name || 'the restaurant';
        const description =
          (currentRestaurant?.shortDescription || 'neighborhood restaurant and takeout spot').trim();
        const instructions = BASE_INSTRUCTIONS.replaceAll(
          '{{RESTAURANT_NAME}}',
          restaurantName
        ).replaceAll('{{RESTAURANT_DESCRIPTION}}', description);
        const greetingText = `Thanks for calling ${restaurantName}. I'm the automated assistant. Are you ordering for pickup or delivery?`;

        console.log('[Realtime] applying restaurant instructions', {
          restaurantId: currentRestaurant?.id,
          restaurantName,
        });

        geminiClient = await connectGeminiLive({
          instructions,
          voice: process.env.GEMINI_LIVE_VOICE,
          audioFormat: DEFAULT_AUDIO_MIME_TYPE,
          tools: [SUBMIT_ORDER_TOOL],
          greetingText,
        });

        if (!geminiClient) {
          console.error('[Gemini] Failed to create Gemini Live session; closing Twilio stream');
          socket.close();
          return null;
        }

        wireGeminiEvents(geminiClient);
        return geminiClient;
      } catch (err) {
        console.error('[Gemini] failed to initialize Gemini Live client', err);
        socket.close();
        return null;
      }
    };

    socket.on('message', (data, isBinary) => {
      try {
        const text = isBinary ? data.toString() : data.toString();
        const message = JSON.parse(text);

        const event = message.event || 'unknown';

        if (event === 'media' && message.media) {
          if (!geminiClientPromise) {
            geminiClientPromise = initializeGemini();
          }
          if (message.media.payload) {
            const payload = message.media.payload;
            geminiClientPromise?.then((client) => {
              client?.sendAudioChunk(payload);
            });
          }
        } else if (event === 'start' && message.start) {
          const sid = message.start.callSid || callSid || 'unknown';
          streamSid = message.start.streamSid || streamSid;
          if (VERBOSE_GEMINI_LOGS) {
            console.log(`[Realtime] event=start callSid=${sid}`);
          }
          if (!currentRestaurant && message.start.customParameters && message.start.customParameters.restaurantId) {
            const rid = message.start.customParameters.restaurantId;
            restaurantReady = loadRestaurantById(rid).then(() => {
              console.log('[Realtime] restaurant loaded from start.customParameters', { restaurantId: rid });
            });
          }
          if (!geminiClientPromise) {
            geminiClientPromise = initializeGemini();
          }
        } else if (event === 'mark' && message.mark) {
          const name = message.mark.name || 'unknown';
          if (VERBOSE_GEMINI_LOGS) {
            console.log(`[Realtime] event=mark name=${name}`);
          }
        } else if (event === 'stop') {
          const sid = callSid || 'unknown';
          if (VERBOSE_GEMINI_LOGS) {
            console.log(`[Realtime] event=stop callSid=${sid}`);
          }
        } else {
          if (VERBOSE_GEMINI_LOGS) {
            console.log(`[Realtime] event=${event}`);
          }
        }
      } catch (err) {
        console.warn('[Realtime] Failed to parse Twilio message as JSON');
      }
    });
    socket.on('close', async (code, reason) => {
      const reasonText = normalizeReason(reason);
      console.log('Twilio stream closed');
      console.log(
        `[Realtime] Twilio stream closed${callSid ? ` (CallSid=${callSid})` : ''}: code=${code} reason=${reasonText}`
      );
      console.log('[Order Tool Count]', submitOrderCount);
      if (lastSubmitOrderPayload && !orderSubmitted) {
        await restaurantReady;
        console.log('[Order Tool Payload @ End]', JSON.stringify(lastSubmitOrderPayload, null, 2));
        try {
          console.log('[Order] Writing order to Firestore once', {
            customerName: lastSubmitOrderPayload.customerName,
            customerPhone: lastSubmitOrderPayload.customerPhone,
            fulfillmentType: lastSubmitOrderPayload.fulfillmentType,
            });
            if (currentRestaurant) {
              await submitOrderToFirebase(lastSubmitOrderPayload, currentRestaurant);
              orderSubmitted = true;
            } else {
              console.error('[Order] missing restaurant context at call end; skipping Firestore write');
            }
        } catch (err) {
          console.error('[Firebase] order create wrapper failed', err);
        }
      }
      if (lastSubmitOrderPayload) {
        console.log('[Call Summary]', {
          restaurantId: currentRestaurant?.id || currentRestaurant?.restaurantId,
          customerName: lastSubmitOrderPayload.customerName,
          fulfillmentType: lastSubmitOrderPayload.fulfillmentType,
          itemCount: Array.isArray(lastSubmitOrderPayload.items) ? lastSubmitOrderPayload.items.length : 0,
        });
      }
      if (geminiClient) {
        geminiClient.close();
      } else if (geminiClientPromise) {
        geminiClientPromise.then((client) => client?.close()).catch(() => {});
      }
    });

    socket.on('error', (error) => {
      console.error(`[Realtime] Twilio stream error${callSid ? ` (CallSid=${callSid})` : ''}:`, error);
    });
  });
}

function normalizeReason(reason) {
  if (!reason) {
    return 'none';
  }
  if (typeof reason === 'string') {
    return reason || 'none';
  }
  if (reason instanceof Buffer) {
    const decoded = reason.toString();
    return decoded || 'none';
  }
  return 'unknown';
}

async function submitOrderToFirebase(orderPayload, restaurant) {
  try {
    const restaurantId = restaurant?.id || restaurant?.restaurantId;
    if (!restaurantId) {
      console.error('[Firebase] missing restaurantId; not writing order');
      return;
    }

    const isDelivery = orderPayload.fulfillmentType === 'delivery';
    const hasAddress = !!(orderPayload.deliveryAddress && orderPayload.deliveryAddress.trim());
    if (isDelivery && !hasAddress) {
      console.error('[Firebase] refusing to write delivery order without address', {
        restaurantId,
        customerName: orderPayload.customerName,
        customerPhone: orderPayload.customerPhone,
      });
      return;
    }

    const orderForFirestore = {
      restaurantId,
      restaurantName: restaurant?.name || "Joe's Pizza",
      customerName: orderPayload.customerName || 'Unknown',
      customerPhone: orderPayload.customerPhone || '',
      fulfillmentType: orderPayload.fulfillmentType || 'pickup',
      deliveryAddress: orderPayload.deliveryAddress || null,
      deliveryApt: orderPayload.deliveryApt || null,
      deliveryNotes: orderPayload.deliveryNotes || null,
      source: 'voice',
      notes: orderPayload.notes || null,
      items: (orderPayload.items || []).map((item) => ({
        menuItemId: item.menuItemId || null,
        name: item.name,
        quantity: item.quantity || 1,
        priceCents: item.priceCents || 0,
        notes: item.notes || null,
        specialInstructions: item.specialInstructions || null,
        restaurantId,
        source: 'voice',
      })),
      subtotalCents: orderPayload.subtotalCents || 0,
      taxCents: orderPayload.taxCents || 0,
      totalCents: orderPayload.totalCents || 0,
      ticketSent: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await db.collection('orders').add(orderForFirestore);
    console.log('[Firebase] order created', docRef.id);
  } catch (err) {
    console.error('[Firebase] order create failed', err);
  }
}
