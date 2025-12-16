# Gemini Live Integration

Gemini Live replaces the previous OpenAI Realtime bridge. Twilio audio (PCMU 8 kHz) is streamed into Gemini Live and the returned PCMU audio is streamed back to Twilio, with barge-in, transcription logging, and `submit_order` function calls preserved.

## Required Environment
- `GEMINI_API_KEY` – Gemini API key with Live access (required).
- `GEMINI_LIVE_MODEL` – defaults to `gemini-live-2.5-flash-preview` (override if you have a different production model).
- `GEMINI_LIVE_ENDPOINT` – optional base URL override.
- `GEMINI_LIVE_VOICE` – optional prebuilt voice name.
- `TWILIO_STREAM_URL` – public WebSocket URL for `/realtime` (e.g., `wss://<railway-app>/realtime`).
- `FIREBASE_SERVICE_ACCOUNT_JSON` – service account JSON string for Firestore (or local `serviceAccountKey.json`).
- `PORT` – server port (default `8080`).

## Local Run
1. Copy `.env.example` to `.env` and set the variables above. For local tunneling, set `TWILIO_STREAM_URL` to your ngrok/etc. URL, e.g. `wss://<ngrok-host>/realtime`.
2. Install deps: `npm install`.
3. Start the server: `npm run dev` (or `npm start`).
4. Point your Twilio Voice webhook at `https://<tunnel-domain>/voice` and place a call. You should hear the greeting and live responses from Gemini.

## Deploying to Railway
1. Create a Railway service from this repo and set the environment variables listed above (including `GEMINI_API_KEY` and `FIREBASE_SERVICE_ACCOUNT_JSON`).
2. Grab the public Railway domain and set `TWILIO_STREAM_URL` to `wss://<railway-domain>/realtime`.
3. Update your Twilio phone number Voice webhook to `https://<railway-domain>/voice`.
4. Redeploy if you change any env vars.

## Smoke Test Checklist
- Call the Twilio number and hear the fixed greeting asking pickup vs delivery.
- Speak over the assistant to trigger barge-in (Twilio receives `clear`, Gemini cancels current audio).
- Confirm that user/assistant transcripts log in the server output.
- Complete an order; ensure `submit_order` tool payload logs and Firestore writes once on call end.
