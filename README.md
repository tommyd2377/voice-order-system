# GoLine Voice Order System

Twilio phone ordering assistant that bridges Twilio Media Streams ↔ Gemini Live ↔ Firestore. The agent greets callers, captures orders, streams audio both ways, and writes confirmed orders to Firestore.

## Prerequisites
- Node.js 20+
- Twilio number with Voice <Stream> enabled
- Firebase project with `restaurants` collection (docs keyed by restaurantId) and admin credentials

## Setup
1. Copy `.env.example` to `.env` and fill in secrets.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run the development server:
   ```bash
   npm run dev
   ```
   Or start once without nodemon:
   ```bash
   npm start
   ```

## Environment Variables
- `GEMINI_API_KEY` (required) – Gemini API key for Live sessions
- `GEMINI_LIVE_MODEL` (optional) – defaults to `gemini-live-2.5-flash-preview`
- `GEMINI_LIVE_ENDPOINT` (optional) – override base URL if needed
- `GEMINI_LIVE_VOICE` (optional) – prebuilt voice name
- `TWILIO_STREAM_URL` – WebSocket URL Twilio connects to (e.g., `wss://your-domain/realtime`)
- `FIREBASE_SERVICE_ACCOUNT_JSON` – service account JSON for Firestore (or use local `serviceAccountKey.json`)
- `PORT` – HTTP port (default `8080`)

## Runtime Behavior
- `POST /voice` looks up the restaurant by the Twilio number and returns TwiML that opens a `<Stream>` to `/realtime`, passing `restaurantId`.
- `/realtime` WebSocket bridges Twilio audio (PCMU 8 kHz) to Gemini Live and streams Gemini audio back to Twilio.
- Gemini Live provides server-side VAD for barge-in, transcription capture for order logs, and function calling for `submit_order`.
- On call end, the last confirmed order payload is written to Firestore once.

## Deployment
- Set the environment variables above in your host (Railway, etc.).
- Ensure `TWILIO_STREAM_URL` points at your public WebSocket endpoint (e.g., Railway domain).
- Keep `GEMINI_API_KEY` and Firebase credentials in your service config; do not commit them.

More operational details live in `docs/gemini-live.md`.
