import type { Context, Hono } from 'hono';
import { createNodeWebSocket } from '@hono/node-ws';
import type { WSContext } from 'hono/ws';
import WebSocket from 'ws';

import { env } from './env.js';
import { firebaseVerifiers } from './firebaseAuth.js';
import type { GuardEnv } from './guard.js';
import { clientIp } from './guard.js';
import {
  buildLiveSetup,
  mapClientMessage,
  mapUpstreamMessage,
  upstreamControl,
} from './liveProtocol.js';
import { authHeaders } from './provider.js';

/**
 * WebSocket relay: phone ⇄ this server ⇄ Vertex AI Live (us-central1).
 *
 * Exists because the Live model is only served from us-central1 and the
 * Firebase client SDK cannot reach it for this project. Relaying also keeps
 * the setup (model, instructions, tools) on the server and lets us apply the
 * same App Check + ID token rules as the REST endpoints.
 */

const AUTH_TIMEOUT_MS = 5000;
const MAX_QUEUED = 40;

const activeSessions = new Set<string>();

function upstreamUrl(location: string): string {
  return `wss://${location}-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent`;
}

export function mountLive(
  app: Hono<GuardEnv>,
  isAllowedOrigin: (origin: string | undefined) => boolean,
) {
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  app.get(
    '/api/live',
    async (c, next) => {
      // A WebSocket is not covered by CORS, so the origin is checked by hand to
      // stop other websites opening sessions from a visitor's browser.
      if (!isAllowedOrigin(c.req.header('origin'))) {
        return c.json({ error: 'Origin not allowed.' }, 403);
      }
      if (!env.gcpProject) {
        return c.json({ error: 'Live voice is not configured.' }, 503);
      }
      return next();
    },
    upgradeWebSocket((c: Context<GuardEnv>) => createSession(clientIp(c))),
  );

  return injectWebSocket;
}

function createSession(ip: string) {
  let client: WSContext | null = null;
  let authed = !env.requireAppCheck;
  let sessionKey = `ip:${ip}`;
  let upstream: WebSocket | null = null;
  let resumeHandle: string | undefined;
  let announcedReady = false;
  let closed = false;
  const queue: unknown[] = [];
  const timers: NodeJS.Timeout[] = [];

  const send = (event: unknown) => {
    if (!closed) client?.send(JSON.stringify(event));
  };

  const shutdown = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    for (const t of timers) clearTimeout(t);
    activeSessions.delete(sessionKey);
    try {
      upstream?.close();
    } catch {
      /* already closed */
    }
    try {
      client?.close(code, reason);
    } catch {
      /* already closed */
    }
  };

  const openUpstream = async () => {
    let auth: Record<string, string>;
    try {
      auth = await authHeaders();
    } catch (error) {
      console.error('[live] no credentials', error);
      send({ type: 'error', message: 'Live voice is not authorised.' });
      shutdown(1011, 'no credentials');
      return;
    }

    const socket = new WebSocket(upstreamUrl(env.liveLocation), { headers: auth });
    const previous = upstream;
    let ready = false;

    socket.on('open', () => {
      socket.send(
        JSON.stringify(
          buildLiveSetup({
            project: env.gcpProject,
            location: env.liveLocation,
            model: env.liveModel,
            voice: env.liveVoice,
            resumeHandle,
          }),
        ),
      );
    });

    socket.on('message', (data) => {
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }

      const control = upstreamControl(message);
      if (control.resumeHandle) resumeHandle = control.resumeHandle;

      for (const event of mapUpstreamMessage(message)) {
        if (event.type === 'ready') {
          ready = true;
          upstream = socket;
          // A resumed connection replaces the old one silently.
          if (previous && previous !== socket) previous.close();
          for (const queued of queue.splice(0)) socket.send(JSON.stringify(queued));
          if (announcedReady) continue;
          announcedReady = true;
        }
        send(event);
      }

      if (control.goAway && !closed) {
        // Google ends connections after ~10 minutes; resume on a new one
        // before this one drops so the conversation continues.
        void openUpstream();
      }
    });

    socket.on('close', (code, reason) => {
      if (closed || upstream !== socket) return;
      if (!ready) {
        console.error(`[live] upstream refused: ${code} ${reason.toString().slice(0, 200)}`);
        send({ type: 'error', message: 'Live voice is unavailable right now.' });
        shutdown(1011, 'upstream refused');
        return;
      }
      if (resumeHandle) {
        void openUpstream();
      } else {
        send({ type: 'error', message: 'Live voice disconnected.' });
        shutdown(1011, 'upstream closed');
      }
    });

    socket.on('error', (error) => {
      console.error('[live] upstream error', error.message);
    });

    if (!upstream) upstream = socket;
  };

  const forward = (message: unknown) => {
    const mapped = mapClientMessage(message);
    if (!mapped) return;
    if (upstream && upstream.readyState === WebSocket.OPEN && announcedReady) {
      upstream.send(JSON.stringify(mapped));
    } else if (queue.length < MAX_QUEUED) {
      queue.push(mapped);
    }
  };

  const start = async () => {
    if (activeSessions.has(sessionKey)) {
      send({ type: 'error', message: 'Live voice is already open on this device.' });
      shutdown(4409, 'duplicate session');
      return;
    }
    activeSessions.add(sessionKey);
    timers.push(
      setTimeout(() => {
        send({ type: 'error', message: 'Live session time limit reached.' });
        shutdown(4000, 'session limit');
      }, env.liveMaxMinutes * 60_000),
    );
    await openUpstream();
  };

  return {
    onOpen(_event: Event, ws: WSContext) {
      client = ws;
      if (authed) {
        void start();
      } else {
        timers.push(
          setTimeout(() => {
            if (!authed) shutdown(4401, 'auth timeout');
          }, AUTH_TIMEOUT_MS),
        );
      }
    },

    async onMessage(event: MessageEvent) {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }

      if (!authed) {
        if (message.type !== 'auth' || typeof message.appCheck !== 'string' || typeof message.idToken !== 'string') {
          shutdown(4401, 'auth required');
          return;
        }
        try {
          const [, user] = await Promise.all([
            firebaseVerifiers.verifyAppCheck(message.appCheck),
            firebaseVerifiers.verifyIdToken(message.idToken),
          ]);
          authed = true;
          sessionKey = `uid:${user.uid}`;
        } catch {
          shutdown(4401, 'auth failed');
          return;
        }
        await start();
        return;
      }

      if (message.type === 'auth') return;
      forward(message);
    },

    onClose() {
      shutdown(1000, 'client closed');
    },

    onError() {
      shutdown(1011, 'client error');
    },
  };
}
