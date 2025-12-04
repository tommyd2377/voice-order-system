import WebSocket, { WebSocketServer } from 'ws';
import { createRequire } from 'module';

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
const VERBOSE_OPENAI_LOGS = process.env.VERBOSE_OPENAI_LOGS === 'true';
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

const DEFAULT_REALTIME_ENDPOINT =
  process.env.OPENAI_REALTIME_ENDPOINT || 'wss://api.openai.com/v1/realtime?model=gpt-realtime-mini';


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
    let orderCompleted = false;

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

    const openaiSocket = connectToOpenAI();
    if (!openaiSocket) {
      console.error('[OpenAI] Failed to create OpenAI WebSocket; closing Twilio stream');
      socket.close();
      return;
    }

    let streamSid = null;
    let activeResponse = false;
    let currentResponseId = null;
    let userSpeaking = false;
    let functionCallBuffer = '';
    let functionCallName = null;
    let functionCallId = null;
    let lastSubmitOrderPayload = null;
    let submitOrderCount = 0;
    let orderSubmitted = false;
    let assistantTextBuffer = '';
    const orderLog = [];

    openaiSocket.on('open', async () => {
      await restaurantReady;

      const restaurantName = currentRestaurant?.name || 'the restaurant';
      const description =
        (currentRestaurant?.shortDescription || 'neighborhood restaurant and takeout spot').trim();
      const instructions = BASE_INSTRUCTIONS.replaceAll('{{RESTAURANT_NAME}}', restaurantName).replaceAll(
        '{{RESTAURANT_DESCRIPTION}}',
        description
      );

      console.log('[Realtime] applying restaurant instructions', {
        restaurantId: currentRestaurant?.id,
        restaurantName,
      });

      const sessionUpdate = {
        type: 'session.update',
        session: {
          type: 'realtime',
          model: 'gpt-realtime-mini',
          instructions,
        },
      };
      openaiSocket.send(JSON.stringify(sessionUpdate));

      const greetingText = `Thanks for calling ${restaurantName}. I'm the automated assistant. Are you ordering for pickup or delivery?`;
      openaiSocket.send(
        JSON.stringify({
          type: 'response.create',
          response: {
            instructions: `Start the call by saying exactly: "${greetingText}" Then stop and wait for the caller's answer before saying anything else.`,
          },
        })
      );
    });

    socket.on('message', (data, isBinary) => {
      try {
        const text = isBinary ? data.toString() : data.toString();
        const message = JSON.parse(text);

        const event = message.event || 'unknown';

        if (event === 'media' && message.media) {
          const seq = message.sequenceNumber ?? message.media.sequenceNumber;
          const chunk = message.media.chunk ? message.media.chunk : message.media.chunkNumber;

          if (message.media.payload && openaiSocket.readyState === WebSocket.OPEN) {
            const payload = message.media.payload;
            const openaiEvent = {
              type: 'input_audio_buffer.append',
              audio: payload,
            };
            openaiSocket.send(JSON.stringify(openaiEvent));
          }
        } else if (event === 'start' && message.start) {
          const sid = message.start.callSid || callSid || 'unknown';
          streamSid = message.start.streamSid || streamSid;
          if (VERBOSE_OPENAI_LOGS) {
            console.log(`[Realtime] event=start callSid=${sid}`);
          }
          if (!currentRestaurant && message.start.customParameters && message.start.customParameters.restaurantId) {
            const rid = message.start.customParameters.restaurantId;
            restaurantReady = loadRestaurantById(rid).then(() => {
              console.log('[Realtime] restaurant loaded from start.customParameters', { restaurantId: rid });
            });
          }
        } else if (event === 'mark' && message.mark) {
          const name = message.mark.name || 'unknown';
          if (VERBOSE_OPENAI_LOGS) {
            console.log(`[Realtime] event=mark name=${name}`);
          }
        } else if (event === 'stop') {
          const sid = callSid || 'unknown';
          if (VERBOSE_OPENAI_LOGS) {
            console.log(`[Realtime] event=stop callSid=${sid}`);
          }
        } else {
          if (VERBOSE_OPENAI_LOGS) {
            console.log(`[Realtime] event=${event}`);
          }
        }
      } catch (err) {
        console.warn('[Realtime] Failed to parse Twilio message as JSON');
      }
    });

    // Handle messages from OpenAI and forward audio deltas back to Twilio.
    openaiSocket.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        const type = message.type;

        // User has started speaking: cancel any in-flight response and stop audio.
        if (type === 'input_audio_buffer.speech_started') {
          if (VERBOSE_OPENAI_LOGS) {
            console.log('[OpenAI] event=input_audio_buffer.speech_started');
          }
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

          if (activeResponse && currentResponseId && openaiSocket.readyState === WebSocket.OPEN) {
            try {
              openaiSocket.send(
                JSON.stringify({
                  type: 'response.cancel',
                  response_id: currentResponseId,
                })
              );
              console.log('[OpenAI] sent response.cancel for active response', currentResponseId);
            } catch (err) {
              console.warn('[OpenAI] failed to send response.cancel', err);
            }
          }

          // Do not process any other handlers for this event.
          return;
        }

        if (type === 'response.created' && message.response && message.response.id) {
          currentResponseId = message.response.id;
          activeResponse = true;
          userSpeaking = false; // model is now speaking
          if (VERBOSE_OPENAI_LOGS) {
            console.log('[OpenAI] event=response.created id=', currentResponseId);
          }
        }

        if (type === 'session.created' || type === 'session.updated') {
          if (message.session && VERBOSE_OPENAI_LOGS) {
            console.log('[OpenAI] session state:', JSON.stringify(message.session, null, 2));
          }
        }

        if (type === 'response.function_call_arguments.delta') {
          functionCallName = message.name || functionCallName;
          functionCallId = message.call_id || message.id || functionCallId;
          const delta = message.arguments || (message.delta && message.delta.arguments) || '';
          if (delta) {
            functionCallBuffer += delta;
          }
        }

        if (type === 'response.function_call_arguments.done') {
          const doneName = message.name || functionCallName;
          const finalArgs =
            (message.arguments || (message.delta && message.delta.arguments) || '') + functionCallBuffer;
          if (doneName === 'submit_order' && finalArgs) {
            try {
              await restaurantReady;
              const payload = JSON.parse(finalArgs);
              lastSubmitOrderPayload = payload;
              submitOrderCount += 1;
              orderCompleted = true;
              console.log('[Order Tool Payload]', JSON.stringify(payload, null, 2));
              if (!currentRestaurant) {
                console.error('[Order Tool Payload] missing restaurant context; skipping Firestore write');
              }

              // Send tool output back to the model so it can continue speaking.
              if (functionCallId && openaiSocket.readyState === WebSocket.OPEN) {
                const toolOutput = {
                  type: 'conversation.item.create',
                  item: {
                    type: 'function_call_output',
                    call_id: functionCallId,
                    output: JSON.stringify(payload),
                  },
                };
                const confirmationText = `Confirm once in a single short sentence the ${
                  payload.fulfillmentType || 'pickup'
                } order is placed${
                  payload.deliveryAddress ? ` to ${payload.deliveryAddress}` : ''
                }. No extra questions.`;
                try {
                  openaiSocket.send(JSON.stringify(toolOutput));
                  openaiSocket.send(
                    JSON.stringify({
                      type: 'response.create',
                      response: {
                        instructions: confirmationText,
                      },
                    })
                  );
                } catch (err) {
                  console.warn('[Order Tool Payload] failed to send tool output', err);
                }
              }

            } catch (err) {
              console.warn('[Order Tool Payload] failed to parse arguments', err);
            }
          }
          functionCallBuffer = '';
          functionCallName = null;
          functionCallId = null;
        }

        if (type === 'conversation.item.input_audio_transcription.completed') {
          const transcript =
            message.transcript ||
            (message.transcription && message.transcription.text) ||
            message.transcription ||
            (message.item && message.item.transcript) ||
            (message.item && message.item.transcription);
          if (transcript) {
            orderLog.push({ from: 'user', text: String(transcript) });
          }
        }

        if (type === 'response.output_text.delta' && message.delta) {
          assistantTextBuffer += message.delta;
        }

        if (
          (type === 'response.output_text.done' || type === 'response.done') &&
          assistantTextBuffer.trim()
        ) {
          orderLog.push({ from: 'assistant', text: assistantTextBuffer.trim() });
          assistantTextBuffer = '';
        }

        if (type === 'response.output_audio.delta' && message.delta) {
          let audioChunk;
          if (typeof message.delta === 'string') {
            // GA realtime: delta is a base64-encoded audio string
            audioChunk = message.delta;
          } else if (message.delta.audio) {
            // Backward compatibility if the audio is nested
            audioChunk = message.delta.audio;
          }

          if (!audioChunk || !streamSid) return;

          // If user has started speaking or response is no longer active, stop sending audio.
          if (userSpeaking || !activeResponse) return;

          const twilioMedia = {
            event: 'media',
            streamSid,
            media: { payload: audioChunk },
          };

          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(twilioMedia));
          }
        } else if (
          type === 'response.output_audio.done' ||
          type === 'response.done' ||
          type === 'response.cancelled'
        ) {
          activeResponse = false;
          if (VERBOSE_OPENAI_LOGS) {
            console.log('[OpenAI] event=response.end type=', type);
          }
        } else if (type === 'error') {
          if (message.error && message.error.code === 'response_cancel_not_active') {
            if (VERBOSE_OPENAI_LOGS) {
              console.log('[OpenAI] cancel_not_active (safe to ignore)');
            }
          } else {
            console.error('[OpenAI] error event payload:', JSON.stringify(message, null, 2));
          }
        } else {
          if (VERBOSE_OPENAI_LOGS) {
            console.log(`[OpenAI] event=${type}`);
          }
        }
      } catch {
        console.warn('[OpenAI] Failed to parse message as JSON');
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
      if (openaiSocket && openaiSocket.readyState === WebSocket.OPEN) {
        openaiSocket.close();
      }
    });

    socket.on('error', (error) => {
      console.error(`[Realtime] Twilio stream error${callSid ? ` (CallSid=${callSid})` : ''}:`, error);
    });
  });
}

export function connectToOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    console.warn('[OpenAI] OPENAI_API_KEY missing; cannot connect to Realtime API.');
    return null;
  }

  console.log('[OpenAI] connecting');

  const ws = new WebSocket(DEFAULT_REALTIME_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  ws.on('open', () => {
    console.log('[OpenAI] connected');

    const fallbackInstructions = BASE_INSTRUCTIONS.replaceAll(
      '{{RESTAURANT_NAME}}',
      'the restaurant'
    ).replaceAll('{{RESTAURANT_DESCRIPTION}}', 'neighborhood restaurant and takeout spot');

    const sessionUpdate = {
      type: 'session.update',
      session: {
        type: 'realtime',
        model: 'gpt-realtime-mini',
        output_modalities: ['audio'],
        instructions: fallbackInstructions,
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            transcription: {
              model: 'gpt-4o-transcribe',
            },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.35,
              prefix_padding_ms: 120,
              silence_duration_ms: 150,
              create_response: true,
              interrupt_response: true,
            },
          },
          output: {
            format: { type: 'audio/pcmu' },
            voice: 'sage',
          },
        },
        tools: [
          {
            type: 'function',
            name: 'submit_order',
            description: 'Submit a confirmed order from this phone call.',
            parameters: {
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
          },
        ],
      },
    };

    ws.send(JSON.stringify(sessionUpdate));
  });

  ws.on('close', () => {
    if (VERBOSE_OPENAI_LOGS) {
      console.log('[OpenAI] closed');
    }
  });

  ws.on('error', (error) => {
    console.error('[OpenAI] error', error);
  });

  return ws;
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
