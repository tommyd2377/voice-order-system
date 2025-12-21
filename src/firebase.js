import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'module';
import admin from 'firebase-admin';
import 'dotenv/config';

const require = createRequire(import.meta.url);

const loadLocalServiceAccount = () => {
  // Local development: fall back to the ignored JSON file.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const localAccount = require('../serviceAccountKey.json');
  console.log('[Firebase] Using local serviceAccountKey.json');
  return localAccount;
};

const parseJson = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const loadServiceAccountFromPath = (pathLike) => {
  if (!pathLike) return null;
  const normalized = pathLike.trim();
  if (!normalized) return null;

  if (existsSync(normalized)) {
    try {
      const contents = readFileSync(normalized, 'utf8');
      const parsed = parseJson(contents);
      if (parsed) {
        console.log('[Firebase] Using service account from path in FIREBASE_SERVICE_ACCOUNT_JSON');
        return parsed;
      }
    } catch {
      // Continue to other fallbacks.
    }
  }
  return null;
};

function loadServiceAccount() {
  const envValue = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (envValue) {
    const parsed = parseJson(envValue);
    if (parsed) {
      console.log('[Firebase] Using service account JSON from FIREBASE_SERVICE_ACCOUNT_JSON env var');
      return parsed;
    }

    const fromPath = loadServiceAccountFromPath(envValue);
    if (fromPath) {
      return fromPath;
    }

    console.warn('[Firebase] FIREBASE_SERVICE_ACCOUNT_JSON is set but could not be parsed; falling back to local file');
  }

  return loadLocalServiceAccount();
}

function initializeFirebase() {
  if (!admin.apps.length) {
    const serviceAccount = loadServiceAccount();
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: 'voice-order-react',
    });
  }

  return admin.firestore();
}

const db = initializeFirebase();

export { admin, db };
