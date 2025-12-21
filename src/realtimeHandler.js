import WebSocket, { WebSocketServer } from 'ws';
import { admin, db } from './firebase.js';
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
"Thanks for calling {{RESTAURANT_NAME}}. How can I help you?"
Then stop and wait for the caller's answer.
Do not repeat this greeting later in the call.

FLEXIBLE ORDER HANDLING (NO FIXED ORDER)
	•	The caller may provide information in any order (items first, delivery info later, etc.).
	•	Accept and remember information whenever it is provided.
	•	Do not force the conversation into a specific sequence.
	•	If the caller starts by listing items, capture them immediately without interruption.

You must collect all required information by the end of the call, but the order does not matter.

REQUIRED INFORMATION (COLLECT GRADUALLY)

By the end of the call, you must have:
	•	Pickup or delivery
	•	Customer name
	•	Phone number
	•	Delivery address (if delivery)
	•	All order items with quantities and notes

Guidelines:
	•	Ask only for missing information, one short question at a time.
	•	Do not re-ask for information already provided.
	•	Do not confirm or repeat details while collecting them.
	•	Use short acknowledgements only (“Got it.”, “Okay.”).

ORDER ITEMS
	•	Capture each item’s name, quantity, and modifiers.
	•	If something is unclear, ask one brief clarifying question.
	•	Do not read items back during collection.
	•	Do not confirm prices unless explicitly provided by a tool.

FINAL CONFIRMATION (ONCE, AT THE END ONLY)

When all required information is collected:
	•	Give one concise summary including:
	•	Pickup or delivery
	•	Name
	•	Phone number
	•	Address (if delivery)
	•	Full item list with quantities and key notes
	•	If a total price is available, include it. Never invent prices.
	•	Ask exactly:

“Is everything correct?”

If corrected:
	•	Update the information
	•	Repeat the single final confirmation once more
	•	Then proceed

STYLE RULES
	•	Be curt, efficient, and transactional.
	•	No filler, no repetition, no step-by-step narration.
	•	Never confirm individual elements mid-call.
	•	The confirmation happens only at the end.

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
  process.env.OPENAI_REALTIME_ENDPOINT || 'wss://api.openai.com/v1/realtime?model=gpt-realtime';
const DEFAULT_MODEL = 'gpt-realtime';
const DEFAULT_RESTAURANT_NAME = 'the restaurant';
const DEFAULT_RESTAURANT_DESCRIPTION = 'neighborhood restaurant and takeout spot';
const SUBMIT_ORDER_TOOL = {
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
};

const buildInstructions = (restaurant) => {
  const restaurantName = restaurant?.name || DEFAULT_RESTAURANT_NAME;
  const description = (restaurant?.shortDescription || DEFAULT_RESTAURANT_DESCRIPTION).trim();

  return BASE_INSTRUCTIONS.replaceAll('{{RESTAURANT_NAME}}', restaurantName).replaceAll(
    '{{RESTAURANT_DESCRIPTION}}',
    description
  );
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

    const resetFunctionCallState = () => {
      functionCallBuffer = '';
      functionCallName = null;
      functionCallId = null;
    };

    const appendFunctionCallChunk = (message) => {
      functionCallName = message.name || functionCallName;
      functionCallId = message.call_id || message.id || functionCallId;

      const delta = message.delta?.arguments;
      if (delta) {
        functionCallBuffer += delta;
        return;
      }

      if (!functionCallBuffer && message.arguments) {
        functionCallBuffer = message.arguments;
      }
    };

    const cancelActiveResponse = () => {
      if (!activeResponse || !currentResponseId || openaiSocket.readyState !== WebSocket.OPEN) {
        return;
      }
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
    };

    const sendClearToTwilio = () => {
      if (!streamSid || socket.readyState !== WebSocket.OPEN) {
        return;
      }
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
    };

    const handleSpeechStarted = () => {
      if (VERBOSE_OPENAI_LOGS) {
        console.log('[OpenAI] event=input_audio_buffer.speech_started');
      }
      userSpeaking = true;
      sendClearToTwilio();
      cancelActiveResponse();
    };

    const handleFunctionCallDone = async () => {
      if (functionCallName !== 'submit_order' || !functionCallBuffer) {
        resetFunctionCallState();
        return;
      }

      try {
        await restaurantReady;
        const payload = JSON.parse(functionCallBuffer);
        lastSubmitOrderPayload = payload;
        submitOrderCount += 1;
        console.log('[Order Tool Payload]', JSON.stringify(payload, null, 2));
        if (!currentRestaurant) {
          console.error('[Order Tool Payload] missing restaurant context; skipping Firestore write');
        }

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
          } order is placed${payload.deliveryAddress ? ` to ${payload.deliveryAddress}` : ''}. No extra questions.`;
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

      resetFunctionCallState();
    };

    const forwardAudioToTwilio = (audioChunk) => {
      if (!streamSid || userSpeaking || !activeResponse) {
        return;
      }

      const twilioMedia = {
        event: 'media',
        streamSid,
        media: { payload: audioChunk },
      };

      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(twilioMedia));
      }
    };

    openaiSocket.on('open', async () => {
      await restaurantReady;

      const instructions = buildInstructions(currentRestaurant);
      const restaurantName = currentRestaurant?.name || DEFAULT_RESTAURANT_NAME;

      console.log('[Realtime] applying restaurant instructions', {
        restaurantId: currentRestaurant?.id,
        restaurantName,
      });

      openaiSocket.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            type: 'realtime',
            model: DEFAULT_MODEL,
            instructions,
          },
        })
      );

      const greetingText = `Thanks for calling ${restaurantName}. How can I help you?`;
      openaiSocket.send(
        JSON.stringify({
          type: 'response.create',
          response: {
            instructions: `Start the call by saying exactly: "${greetingText}" Then stop and wait for the caller's answer before saying anything else.`,
          },
        })
      );
    });

    const handleTwilioMessage = (data, isBinary) => {
      try {
        const message = JSON.parse(isBinary ? data.toString() : data.toString());
        const event = message.event || 'unknown';

        switch (event) {
          case 'media':
            if (message.media?.payload && openaiSocket.readyState === WebSocket.OPEN) {
              openaiSocket.send(
                JSON.stringify({
                  type: 'input_audio_buffer.append',
                  audio: message.media.payload,
                })
              );
            }
            break;
          case 'start':
            if (VERBOSE_OPENAI_LOGS) {
              const sid = message.start?.callSid || callSid || 'unknown';
              console.log(`[Realtime] event=start callSid=${sid}`);
            }
            streamSid = message.start?.streamSid || streamSid;
            if (!currentRestaurant && message.start?.customParameters?.restaurantId) {
              const rid = message.start.customParameters.restaurantId;
              restaurantReady = loadRestaurantById(rid).then(() => {
                console.log('[Realtime] restaurant loaded from start.customParameters', { restaurantId: rid });
              });
            }
            break;
          case 'mark':
            if (VERBOSE_OPENAI_LOGS) {
              const name = message.mark?.name || 'unknown';
              console.log(`[Realtime] event=mark name=${name}`);
            }
            break;
          case 'stop':
            if (VERBOSE_OPENAI_LOGS) {
              const sid = callSid || 'unknown';
              console.log(`[Realtime] event=stop callSid=${sid}`);
            }
            break;
          default:
            if (VERBOSE_OPENAI_LOGS) {
              console.log(`[Realtime] event=${event}`);
            }
        }
      } catch (err) {
        console.warn('[Realtime] Failed to parse Twilio message as JSON');
      }
    };

    socket.on('message', handleTwilioMessage);

    const handleOpenAiMessage = async (data) => {
      try {
        const message = JSON.parse(data.toString());
        const type = message.type;

        switch (type) {
          case 'input_audio_buffer.speech_started':
            handleSpeechStarted();
            return;
          case 'response.created':
            currentResponseId = message.response?.id || currentResponseId;
            activeResponse = true;
            userSpeaking = false;
            if (VERBOSE_OPENAI_LOGS) {
              console.log('[OpenAI] event=response.created id=', currentResponseId);
            }
            break;
          case 'session.created':
          case 'session.updated':
            if (message.session && VERBOSE_OPENAI_LOGS) {
              console.log('[OpenAI] session state:', JSON.stringify(message.session, null, 2));
            }
            break;
          case 'response.function_call_arguments.delta':
            appendFunctionCallChunk(message);
            break;
          case 'response.function_call_arguments.done':
            appendFunctionCallChunk(message);
            await handleFunctionCallDone();
            break;
          case 'response.output_audio.delta': {
            const audioChunk =
              typeof message.delta === 'string' ? message.delta : message.delta && message.delta.audio;
            if (audioChunk) {
              forwardAudioToTwilio(audioChunk);
            }
            break;
          }
          case 'response.output_audio.done':
          case 'response.done':
          case 'response.cancelled':
            activeResponse = false;
            if (VERBOSE_OPENAI_LOGS) {
              console.log('[OpenAI] event=response.end type=', type);
            }
            break;
          case 'error':
            if (message.error && message.error.code === 'response_cancel_not_active') {
              if (VERBOSE_OPENAI_LOGS) {
                console.log('[OpenAI] cancel_not_active (safe to ignore)');
              }
            } else {
              console.error('[OpenAI] error event payload:', JSON.stringify(message, null, 2));
            }
            break;
          default:
            if (VERBOSE_OPENAI_LOGS) {
              console.log(`[OpenAI] event=${type}`);
            }
        }
      } catch {
        console.warn('[OpenAI] Failed to parse message as JSON');
      }
    };

    // Handle messages from OpenAI and forward audio deltas back to Twilio.
    openaiSocket.on('message', handleOpenAiMessage);

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

    const fallbackInstructions = buildInstructions();

    const sessionUpdate = {
      type: 'session.update',
      session: {
        type: 'realtime',
        model: DEFAULT_MODEL,
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
              threshold: 0.65,
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
        tools: [SUBMIT_ORDER_TOOL],
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
