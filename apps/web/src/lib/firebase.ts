/**
 * Firebase on the client: App Check + anonymous sign-in.
 *
 * Every paid API call carries two tokens so the server can prove the request
 * came from this app on a real device (App Check, via invisible reCAPTCHA
 * Enterprise) and tell devices apart for rate limiting (anonymous auth). There
 * is no sign-up screen — a blind user should never meet a login form.
 *
 * The Firebase web config is public by design; it identifies the project, it
 * does not grant access. Nothing secret lives here.
 *
 * Loaded lazily on the first API call so it never delays first paint, and
 * skipped entirely when the config is absent so local development needs no
 * Firebase project at all.
 */

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string | undefined,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string | undefined,
};
const siteKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY as string | undefined;

export const firebaseEnabled = Boolean(config.apiKey && config.appId && siteKey);

type HeaderSource = () => Promise<Record<string, string>>;

let ready: Promise<HeaderSource> | null = null;

async function init(): Promise<HeaderSource> {
  const [{ initializeApp }, appCheckModule, authModule] = await Promise.all([
    import('firebase/app'),
    import('firebase/app-check'),
    import('firebase/auth'),
  ]);

  // Local development cannot pass reCAPTCHA on localhost reliably, so dev
  // builds use a registered App Check debug token instead. Never in production.
  if (import.meta.env.DEV) {
    (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: string | boolean })
      .FIREBASE_APPCHECK_DEBUG_TOKEN =
      (import.meta.env.VITE_APPCHECK_DEBUG_TOKEN as string | undefined) || true;
  }

  const app = initializeApp(config);
  const appCheck = appCheckModule.initializeAppCheck(app, {
    provider: new appCheckModule.ReCaptchaEnterpriseProvider(siteKey as string),
    isTokenAutoRefreshEnabled: true,
  });
  const auth = authModule.getAuth(app);

  return async () => {
    // Wait for a persisted session to be restored, or every page load would
    // mint a brand-new anonymous user.
    await auth.authStateReady();
    const user =
      auth.currentUser ?? (await authModule.signInAnonymously(auth)).user;

    const [appCheckToken, idToken] = await Promise.all([
      appCheckModule.getToken(appCheck, false),
      user.getIdToken(),
    ]);

    return {
      'X-Firebase-AppCheck': appCheckToken.token,
      Authorization: `Bearer ${idToken}`,
    };
  };
}

/**
 * Headers to attach to every `/api` call. Empty when Firebase is not
 * configured. Never throws: if attestation fails, the request goes out
 * without tokens and the server answers 401, which the caller already turns
 * into a spoken message — while on-device hazard alerts keep working.
 */
export async function authHeaders(): Promise<Record<string, string>> {
  if (!firebaseEnabled) return {};
  ready ??= init();
  try {
    return await (await ready)();
  } catch (error) {
    console.warn('[firebase] could not obtain security tokens', error);
    // Allow a later call to retry initialisation from scratch.
    ready = null;
    return {};
  }
}
