import { getApps, initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import type { Auth } from 'firebase/auth';
import type { Firestore } from 'firebase/firestore';

export interface FirebaseServices {
  auth: Auth;
  firestore: Firestore;
}

let services: FirebaseServices | null | undefined;
let configurationError: string | null = null;

export function getFirebaseConfigurationError(): string | null {
  return configurationError;
}

export function getFirebaseServices(): FirebaseServices | null {
  if (services !== undefined) return services;
  const emulator = import.meta.env.VITE_USE_FIREBASE_EMULATORS === 'true';
  const apiKey = import.meta.env.VITE_FIREBASE_API_KEY;
  const authDomain = import.meta.env.VITE_FIREBASE_AUTH_DOMAIN;
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID;
  const appId = import.meta.env.VITE_FIREBASE_APP_ID;
  if (!emulator && !(apiKey && authDomain && projectId && appId)) {
    services = null;
    return services;
  }

  const options = emulator
    ? {
        apiKey: 'demo-key',
        authDomain: 'demo-kitchen.firebaseapp.com',
        projectId: 'demo-kitchen',
        appId: 'demo-app',
      }
    : { apiKey, authDomain, projectId, appId };
  try {
    const app =
      getApps().find((entry) => entry.name === 'kitchen-wrapper') ??
      initializeApp(options, 'kitchen-wrapper');
    const auth = getAuth(app);
    const firestore = getFirestore(app);
    if (emulator) {
      connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
      connectFirestoreEmulator(firestore, '127.0.0.1', 8080);
    }
    services = { auth, firestore };
  } catch {
    configurationError = 'Cloud setup is unavailable. Inventory is saved in this browser only.';
    services = null;
  }
  return services;
}
