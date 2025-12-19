import http from 'node:http';
import express from 'express';
import dotenv from 'dotenv';
import { createRequire } from 'module';
import { attachRealtimeServer } from './realtimeHandler.js';

const require = createRequire(import.meta.url);
const admin = require('firebase-admin');

let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  // Hosted (Railway, etc): JSON string from env var
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  console.log('[Firebase] Using service account from FIREBASE_SERVICE_ACCOUNT_JSON env var');
} else {
  // Local dev: use the ignored file
  // Make sure serviceAccountKey.json exists locally and is in .gitignore
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  serviceAccount = require('../serviceAccountKey.json');
  console.log('[Firebase] Using local serviceAccountKey.json');
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: 'voice-order-react',
  });
}

const db = admin.firestore();

dotenv.config();

const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
const DEFAULT_GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com';
const DEFAULT_WS_PATH = '/ws/google.ai.generativelanguage.v1beta.GenerativeService/BidiGenerateContent';
const DEFAULT_GEMINI_VOICE = 'Puck';

function cleanEnv(value) {
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  return trimmed.length ? trimmed : undefined;
}

const envModel = cleanEnv(process.env.GEMINI_LIVE_MODEL);
const envEndpoint = cleanEnv(process.env.GEMINI_LIVE_ENDPOINT);
const envVoice = cleanEnv(process.env.GEMINI_LIVE_VOICE);
const resolvedModel = envModel || DEFAULT_GEMINI_MODEL;
const resolvedEndpoint = envEndpoint || DEFAULT_GEMINI_ENDPOINT;
const resolvedVoice = envVoice || DEFAULT_GEMINI_VOICE;
const resolvedWebsocketUrl = `${resolvedEndpoint}${DEFAULT_WS_PATH}`;

console.log('[Boot][Gemini] configuration', {
  GEMINI_LIVE_MODEL: envModel || '(unset)',
  GEMINI_LIVE_ENDPOINT: envEndpoint || '(unset)',
  GEMINI_LIVE_VOICE: envVoice || '(unset)',
  resolvedModel,
  resolvedEndpoint,
  resolvedWebsocketUrl,
});

const app = express();

// Twilio sends webhook payloads as application/x-www-form-urlencoded.
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Twilio voice webhook -> return TwiML that connects to the stream endpoint.
app.post('/voice', async (req, res) => {
  const toNumber = req.body?.To;
  console.log('[Twilio] incoming /voice webhook', { to: toNumber });

  if (!toNumber) {
    console.error('[Twilio] missing To number in webhook payload');
    res
      .type('text/xml')
      .send('<Response><Say>Sorry, we could not identify the number you dialed.</Say></Response>');
    return;
  }

  let restaurantId = null;
  let restaurantName = "Joe's Pizza";

  try {
    const snap = await db.collection('restaurants').where('twilioNumber', '==', toNumber).limit(1).get();
    if (snap.empty) {
      console.error('[Twilio] restaurant not found for dialed number', { to: toNumber });
      res
        .type('text/xml')
        .send(
          '<Response><Say>Sorry, we could not route your call to a restaurant. Please try again later.</Say></Response>'
        );
      return;
    }

    const doc = snap.docs[0];
    restaurantId = doc.id;
    const data = doc.data() || {};
    restaurantName = data.name || restaurantName;
    console.log('[Twilio] restaurant resolved for call', { to: toNumber, restaurantId, restaurantName });
  } catch (err) {
    console.error('[Twilio] failed to look up restaurant by number', { to: toNumber, err });
    res
      .type('text/xml')
      .send('<Response><Say>Sorry, we could not route your call right now.</Say></Response>');
    return;
  }

  const streamUrl = `wss://${process.env.TWILIO_STREAM_URL}?restaurantId=${encodeURIComponent(restaurantId)}`;

  const twiml = `
    <Response>
      <Connect>
        <Stream url="${streamUrl}" track="inbound_track">
          <Parameter name="restaurantId" value="${restaurantId}" />
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
