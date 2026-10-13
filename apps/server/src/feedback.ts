/**
 * Anonymous "Was this description helpful? Yes / No" feedback, stored in
 * Cloud Firestore (collection `feedback`).
 *
 * No PII: only a boolean, an optional place category, an optional app
 * version, and a server timestamp. No text input, no login beyond the
 * existing anonymous auth.
 *
 * Firestore database must exist in the Firebase project (Console → Build →
 * Firestore Database → Create, production mode, asia-south1) or writes will
 * degrade to stored:false. A failed write NEVER breaks the main app: this
 * returns false and the API answers { stored: false }.
 */
import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

import { env } from './env.js';

export interface FeedbackInput {
  helpful: boolean;
  placeCategory?: string;
  appVersion?: string;
}

/** Pure validation — safe to unit-test without touching Firestore. */
export function validateFeedbackBody(
  body: unknown,
): { ok: true; value: FeedbackInput } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Malformed request body.' };
  }
  const { helpful, placeCategory, appVersion } = body as Record<string, unknown>;
  if (typeof helpful !== 'boolean') {
    return { ok: false, error: 'helpful must be a boolean.' };
  }
  if (
    placeCategory !== undefined &&
    (typeof placeCategory !== 'string' || placeCategory.length > 40)
  ) {
    return { ok: false, error: 'placeCategory must be a string up to 40 characters.' };
  }
  if (
    appVersion !== undefined &&
    (typeof appVersion !== 'string' || appVersion.length > 40)
  ) {
    return { ok: false, error: 'appVersion must be a string up to 40 characters.' };
  }
  return {
    ok: true,
    value: {
      helpful,
      placeCategory: typeof placeCategory === 'string' ? placeCategory : undefined,
      appVersion: typeof appVersion === 'string' ? appVersion : undefined,
    },
  };
}

/** Write one feedback doc. Returns false (never throws) on any failure. */
export async function storeFeedback(input: FeedbackInput): Promise<boolean> {
  try {
    const app =
      getApps()[0] ??
      initializeApp(env.gcpProject ? { projectId: env.gcpProject } : undefined);
    await getFirestore(app)
      .collection('feedback')
      .add({
        helpful: input.helpful,
        placeCategory: input.placeCategory ?? null,
        appVersion: input.appVersion ?? null,
        createdAt: FieldValue.serverTimestamp(),
      });
    return true;
  } catch (error) {
    console.error('[feedback] Firestore write failed (degraded to stored:false)', error);
    return false;
  }
}
