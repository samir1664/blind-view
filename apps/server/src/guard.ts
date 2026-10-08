import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';

/**
 * Only our own app may spend our AI budget.
 *
 * Every paid endpoint requires two Firebase tokens:
 *  - App Check proves the request comes from the genuine Blind View web app
 *    (reCAPTCHA Enterprise attestation), not a script that found the URL.
 *  - The anonymous-auth ID token gives each device a stable identity, which is
 *    what rate limiting keys on — an IP is shared by a whole café or carrier.
 *
 * `required: false` keeps local development working without any Firebase setup.
 */

export interface GuardOptions {
  required: boolean;
  verifyAppCheck(token: string): Promise<unknown>;
  verifyIdToken(token: string): Promise<{ uid: string }>;
}

export type GuardEnv = { Variables: { clientKey: string } };

export function clientIp(c: Context): string {
  return (
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    c.req.header('cf-connecting-ip') ||
    'local'
  );
}

function unauthenticated(c: Context) {
  return c.json(
    { error: 'Security check failed. Reload the app.', code: 'UNAUTHENTICATED' },
    401,
  );
}

export function createGuard(options: GuardOptions) {
  return createMiddleware<GuardEnv>(async (c, next) => {
    if (!options.required) {
      c.set('clientKey', `ip:${clientIp(c)}`);
      return next();
    }

    const appCheck = c.req.header('x-firebase-appcheck');
    const bearer = c.req.header('authorization')?.match(/^Bearer (.+)$/)?.[1];
    if (!appCheck || !bearer) return unauthenticated(c);

    try {
      const [, user] = await Promise.all([
        options.verifyAppCheck(appCheck),
        options.verifyIdToken(bearer),
      ]);
      c.set('clientKey', `uid:${user.uid}`);
    } catch {
      return unauthenticated(c);
    }

    return next();
  });
}
