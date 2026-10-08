import { getApps, initializeApp } from 'firebase-admin/app';
import { getAppCheck } from 'firebase-admin/app-check';
import { getAuth } from 'firebase-admin/auth';

import { env } from './env.js';
import type { GuardOptions } from './guard.js';

/**
 * Real token verifiers backed by firebase-admin. Initialised lazily so local
 * development without Firebase never touches it. Credentials come from ADC
 * (the Cloud Run service account), and verification uses Google's public
 * signing keys — no secret is involved.
 */
function app() {
  return (
    getApps()[0] ??
    initializeApp(env.gcpProject ? { projectId: env.gcpProject } : undefined)
  );
}

export const firebaseVerifiers: Pick<
  GuardOptions,
  'verifyAppCheck' | 'verifyIdToken'
> = {
  verifyAppCheck: (token) => getAppCheck(app()).verifyToken(token),
  verifyIdToken: (token) => getAuth(app()).verifyIdToken(token),
};
