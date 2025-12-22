import 'dotenv/config';
import http from 'node:http';
import express from 'express';
import { db } from './firebase.js';
import { attachRealtimeServer } from './realtimeHandler.js';

const app = express();

// Twilio sends webhook payloads as application/x-www-form-urlencoded.
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const DEFAULT_RESTAURANT_NAME = "Joe's Pizza";

const sendTwimlMessage = (res, message) => {
  res.type('text/xml').send(`<Response><Say>${message}</Say></Response>`);
};

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Twilio voice webhook -> return TwiML that connects to the stream endpoint.
app.post('/voice', async (req, res) => {
  const toNumber = req.body?.To;
  console.log('[Twilio] incoming /voice webhook', { to: toNumber });

  if (!toNumber) {
    console.error('[Twilio] missing To number in webhook payload');
    sendTwimlMessage(res, 'Sorry, we could not identify the number you dialed.');
    return;
  }

  let restaurantId = null;
  let restaurantName = DEFAULT_RESTAURANT_NAME;

  try {
    const snap = await db.collection('restaurants').where('twilioNumber', '==', toNumber).limit(1).get();
    if (snap.empty) {
      console.error('[Twilio] restaurant not found for dialed number', { to: toNumber });
      sendTwimlMessage(res, 'Sorry, we could not route your call to a restaurant. Please try again later.');
      return;
    }

    const doc = snap.docs[0];
    restaurantId = doc.id;
    const data = doc.data() || {};
    restaurantName = data.name || restaurantName;
    console.log('[Twilio] restaurant resolved for call', { to: toNumber, restaurantId, restaurantName });
  } catch (err) {
    console.error('[Twilio] failed to look up restaurant by number', { to: toNumber, err });
    sendTwimlMessage(res, 'Sorry, we could not route your call right now.');
    return;
  }

  const { TWILIO_STREAM_URL } = process.env;
  if (!TWILIO_STREAM_URL) {
    console.error('[Twilio] TWILIO_STREAM_URL not configured');
    sendTwimlMessage(res, 'Sorry, we cannot connect your call right now.');
    return;
  }

  const streamUrl = `wss://${TWILIO_STREAM_URL}?restaurantId=${encodeURIComponent(restaurantId)}`;

  const twiml = `
    <Response>
      <Connect>
        <Stream url="${streamUrl}" track="inbound_track">
          <Parameter name="restaurantId" value="${restaurantId}" />
          <Parameter name="customerPhone" value="${req.body.From}" />
        </Stream>
      </Connect>
    </Response>
  `;

  res.type('text/xml');
  res.send(twiml.trim());
});

const port = process.env.PORT || 8080;
const server = http.createServer(app);

// Attach the existing realtime WebSocket server to this HTTP server.
attachRealtimeServer(server);

server.listen(port, () => {
  console.log(`GoLine Day-1 server listening on port ${port}`);
});
