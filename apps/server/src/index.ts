import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import { env } from './env.js';
import { firebaseVerifiers } from './firebaseAuth.js';
import { GeminiError, generateDescription } from './gemini.js';
import { createGuard } from './guard.js';
import type { GuardEnv } from './guard.js';
import { mountLive } from './live.js';
import { classifyPlace } from './place.js';
import type { PlaceContext } from './place.js';
import { PLACE_CATEGORIES } from './playbooks.js';
import type { Environment, PlaceCategory } from './playbooks.js';
import { buildPrompt, MODES, VERBOSITIES } from './prompts.js';
import type { Mode, Verbosity } from './prompts.js';
import { isVisionConfigured } from './provider.js';
import { checkRateLimit } from './rateLimit.js';
import { analyzeScene } from './scene.js';
import { synthesizeSpeech } from './tts.js';
import { SCENE_TASKS } from './scenePrompts.js';
import type { SceneTask } from './scenePrompts.js';

const hasVision = isVisionConfigured();

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Private-network origins, so a phone on the same Wi-Fi can hit the dev server. */
const LAN_ORIGIN_RE =
  /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/;

const isProduction = process.env.NODE_ENV === 'production';

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return !isProduction; // non-browser clients only in dev
  if (env.allowedOrigins.includes('*')) return true;
  if (env.allowedOrigins.includes(origin)) return true;
  return !isProduction && LAN_ORIGIN_RE.test(origin);
}

const app = new Hono<GuardEnv>();

const guard = createGuard({
  required: env.requireAppCheck,
  ...firebaseVerifiers,
});

app.use('*', logger());

app.use(
  '/api/*',
  cors({
    origin: (origin) => {
      if (!origin) return origin; // same-origin / native shell
      return isAllowedOrigin(origin) ? origin : null;
    },
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Firebase-AppCheck'],
    maxAge: 86_400,
  }),
);

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    // Lets the client warn the user before they try to use narration.
    visionConfigured: hasVision,
    provider: env.provider,
    models: env.geminiModels,
    uptimeSec: Math.round(process.uptime()),
  }),
);

interface DescribeBody {
  imageBase64?: unknown;
  mimeType?: unknown;
  mode?: unknown;
  verbosity?: unknown;
  query?: unknown;
  recent?: unknown;
  detections?: unknown;
  place?: unknown;
}

/** Shared image validation for every endpoint that accepts a frame. */
function parseImage(
  raw: unknown,
  mime: unknown,
): { data: string; mimeType: string } | { error: string; status: 400 | 413 } {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { error: 'Missing image.', status: 400 };
  }
  // Accept either a raw base64 payload or a full data: URL.
  const data = raw.replace(/^data:[^;]+;base64,/, '').trim();
  if (!BASE64_RE.test(data)) {
    return { error: 'Image is not valid base64.', status: 400 };
  }
  if ((data.length * 3) / 4 / 1024 > env.maxImageKb) {
    return { error: 'Image too large.', status: 413 };
  }
  return {
    data,
    mimeType:
      typeof mime === 'string' && ALLOWED_MIME.has(mime) ? mime : 'image/jpeg',
  };
}

/**
 * The client echoes back the place context it already holds. It is untrusted
 * input that lands in a prompt, so every field is re-validated and clamped
 * rather than passed through.
 */
function parsePlace(value: unknown): PlaceContext | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;

  const category = candidate.category;
  if (
    typeof category !== 'string' ||
    !PLACE_CATEGORIES.includes(category as PlaceCategory)
  ) {
    return null;
  }

  const clean = (input: unknown, max: number) =>
    typeof input === 'string'
      ? input.replace(/[^\p{L}\p{N} ,.'\-]/gu, '').slice(0, max)
      : '';

  const environment: Environment =
    candidate.environment === 'indoor' ? 'indoor' : 'outdoor';
  const place = clean(candidate.place, 40);
  const confidence = Number(candidate.confidence);

  return {
    environment,
    category: category as PlaceCategory,
    place,
    confidence: Number.isFinite(confidence)
      ? Math.max(0, Math.min(1, confidence))
      : 0.5,
    announcement: clean(candidate.announcement, 140),
    watchFor: Array.isArray(candidate.watchFor)
      ? candidate.watchFor.slice(0, 3).map((w) => clean(w, 48)).filter(Boolean)
      : [],
    path: `${environment} > ${category} > ${place}`,
  };
}

app.post(
  '/api/describe',
  bodyLimit({
    maxSize: (env.maxImageKb + 64) * 1024,
    onError: (c) => c.json({ error: 'Image too large.' }, 413),
  }),
  guard,
  async (c) => {
    if (!hasVision) {
      return c.json(
        {
          error:
            'Vision is not configured. Set GOOGLE_CLOUD_PROJECT (Vertex AI) or GEMINI_API_KEY in .env and restart the server.',
          code: 'NO_API_KEY',
        },
        503,
      );
    }

    const limit = checkRateLimit(c.get('clientKey'), env.rateLimitPerMin);
    if (!limit.allowed) {
      c.header('Retry-After', String(limit.retryAfterSec));
      return c.json(
        { error: 'Too many requests. Slow down.', code: 'RATE_LIMITED' },
        429,
      );
    }

    let body: DescribeBody;
    try {
      body = await c.req.json<DescribeBody>();
    } catch {
      return c.json({ error: 'Malformed request body.' }, 400);
    }

    // ── Validate image ──────────────────────────────────────────
    const image = parseImage(body.imageBase64, body.mimeType);
    if ('error' in image) {
      return c.json({ error: image.error }, image.status);
    }

    // ── Validate options ────────────────────────────────────────
    const mode: Mode = MODES.includes(body.mode as Mode)
      ? (body.mode as Mode)
      : 'scene';

    const verbosity: Verbosity = VERBOSITIES.includes(body.verbosity as Verbosity)
      ? (body.verbosity as Verbosity)
      : 'normal';

    const query =
      typeof body.query === 'string'
        ? body.query.replace(/\s+/g, ' ').slice(0, 200).trim()
        : undefined;

    const recent = Array.isArray(body.recent)
      ? body.recent
          .filter((r): r is string => typeof r === 'string')
          .slice(-4)
          .map((r) => r.replace(/\s+/g, ' ').slice(0, 200))
      : [];

    const detections = Array.isArray(body.detections)
      ? body.detections
          .filter((d): d is string => typeof d === 'string')
          .slice(0, 12)
          .map((d) => d.replace(/[^a-z0-9 -]/gi, '').slice(0, 40))
          .filter(Boolean)
      : [];

    const { system, user } = buildPrompt({
      mode,
      verbosity,
      query,
      recent,
      detections,
      place: parsePlace(body.place),
    });

    const startedAt = Date.now();
    try {
      const text = await generateDescription({
        system,
        user,
        imageBase64: image.data,
        mimeType: image.mimeType,
        mode,
        verbosity,
      });

      return c.json({
        text,
        mode,
        latencyMs: Date.now() - startedAt,
      });
    } catch (error) {
      if (error instanceof GeminiError) {
        // Tell the client how long to stay quiet, so a quota error cannot
        // become a retry storm.
        if (error.status === 429 || error.status === 503) {
          c.header('Retry-After', error.status === 429 ? '30' : '5');
        }
        return c.json(
          { error: error.message, retryable: error.retryable },
          error.status as 400,
        );
      }
      console.error('[describe] unexpected failure', error);
      return c.json({ error: 'Description failed.', retryable: true }, 500);
    }
  },
);

/**
 * Identify where the user is, as a hierarchy: indoor > mall > escalator.
 *
 * Runs on a much slower cadence than /api/describe. The answer is reused
 * across many narration turns to pick the right vocabulary and hazards.
 */
app.post(
  '/api/place',
  bodyLimit({
    maxSize: (env.maxImageKb + 64) * 1024,
    onError: (c) => c.json({ error: 'Image too large.' }, 413),
  }),
  guard,
  async (c) => {
    if (!hasVision) {
      return c.json(
        { error: 'Vision is not configured.', code: 'NO_API_KEY' },
        503,
      );
    }

    const limit = checkRateLimit(c.get('clientKey'), env.rateLimitPerMin);
    if (!limit.allowed) {
      c.header('Retry-After', String(limit.retryAfterSec));
      return c.json({ error: 'Too many requests.', code: 'RATE_LIMITED' }, 429);
    }

    let body: DescribeBody;
    try {
      body = await c.req.json<DescribeBody>();
    } catch {
      return c.json({ error: 'Malformed request body.' }, 400);
    }

    const image = parseImage(body.imageBase64, body.mimeType);
    if ('error' in image) {
      return c.json({ error: image.error }, image.status);
    }

    const detections = Array.isArray(body.detections)
      ? body.detections
          .filter((d): d is string => typeof d === 'string')
          .slice(0, 12)
          .map((d) => d.replace(/[^a-z0-9 -]/gi, '').slice(0, 40))
          .filter(Boolean)
      : [];

    const startedAt = Date.now();
    try {
      const place = await classifyPlace({
        imageBase64: image.data,
        mimeType: image.mimeType,
        previous: parsePlace(body.place),
        detections,
      });
      return c.json({ place, latencyMs: Date.now() - startedAt });
    } catch (error) {
      if (error instanceof GeminiError) {
        if (error.status === 429 || error.status === 503) {
          c.header('Retry-After', error.status === 429 ? '30' : '5');
        }
        return c.json(
          { error: error.message, retryable: error.retryable },
          error.status as 400,
        );
      }
      console.error('[place] unexpected failure', error);
      return c.json({ error: 'Place detection failed.', retryable: true }, 500);
    }
  },
);

/**
 * The eye assistant's single vision call: structured scene analysis with
 * directions computed from boxes, returned as ready-to-speak text.
 */
app.post(
  '/api/scene',
  bodyLimit({
    maxSize: (env.maxImageKb + 64) * 1024,
    onError: (c) => c.json({ error: 'Image too large.' }, 413),
  }),
  guard,
  async (c) => {
    if (!hasVision) {
      return c.json({ error: 'Vision is not configured.', code: 'NO_API_KEY' }, 503);
    }

    const limit = checkRateLimit(c.get('clientKey'), env.rateLimitPerMin);
    if (!limit.allowed) {
      c.header('Retry-After', String(limit.retryAfterSec));
      return c.json({ error: 'Too many requests.', code: 'RATE_LIMITED' }, 429);
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: 'Malformed request body.' }, 400);
    }

    const image = parseImage(body.imageBase64, body.mimeType);
    if ('error' in image) {
      return c.json({ error: image.error }, image.status);
    }

    const task = SCENE_TASKS.includes(body.task as SceneTask)
      ? (body.task as SceneTask)
      : 'orient';
    const verbosity = VERBOSITIES.includes(body.verbosity as Verbosity)
      ? (body.verbosity as Verbosity)
      : 'normal';
    const text = (value: unknown, max: number) =>
      typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : undefined;

    const startedAt = Date.now();
    try {
      const result = await analyzeScene({
        imageBase64: image.data,
        mimeType: image.mimeType,
        task,
        verbosity,
        query: text(body.query, 200),
        previous: text(body.previous, 400),
        localEvents: Array.isArray(body.localEvents)
          ? body.localEvents
              .filter((e): e is string => typeof e === 'string')
              .slice(0, 6)
              .map((e) => e.slice(0, 80))
          : [],
        walking: typeof body.walking === 'boolean' ? body.walking : undefined,
        mirrored: body.mirrored === true,
      });
      return c.json({ ...result, task, latencyMs: Date.now() - startedAt });
    } catch (error) {
      if (error instanceof GeminiError) {
        if (error.status === 429 || error.status === 503) {
          c.header('Retry-After', error.status === 429 ? '30' : '5');
        }
        return c.json({ error: error.message, retryable: error.retryable }, error.status as 400);
      }
      console.error('[scene] unexpected failure', error);
      return c.json({ error: 'Scene analysis failed.', retryable: true }, 500);
    }
  },
);

/** Fallback voice: Cloud TTS (Chirp 3 HD) when Live fails. Same guard + rate limit as /api/scene. */
app.post('/api/tts', guard, async (c) => {
  const limit = checkRateLimit(c.get('clientKey'), env.rateLimitPerMin);
  if (!limit.allowed) {
    c.header('Retry-After', String(limit.retryAfterSec));
    return c.json({ error: 'Too many requests.', code: 'RATE_LIMITED' }, 429);
  }
  let body: { text?: unknown; language?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: 'Malformed request body.' }, 400); }
  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) return c.json({ error: 'Missing text.' }, 400);
  const language = typeof body.language === 'string' && body.language.trim()
    ? body.language.trim().slice(0, 20)
    : 'en-US';
  try {
    const audio = await synthesizeSpeech(text, language);
    return c.json({ audioContent: audio, mimeType: 'audio/mpeg' });
  } catch (error) {
    console.error('[tts] failed', error);
    return c.json({ error: 'Speech synthesis failed.', retryable: true }, 500);
  }
});

const injectWebSocket = mountLive(app, isAllowedOrigin);

app.notFound((c) => c.json({ error: 'Not found.' }, 404));


const server = serve({ fetch: app.fetch, port: env.port, hostname: '0.0.0.0' }, (info) => {
  console.log(`\n  Blind View API  →  http://localhost:${info.port}`);
  console.log(`  Models          →  ${env.geminiModels.join(' → ')}`);
  console.log(
    `  App Check       →  ${env.requireAppCheck ? 'required' : 'off (local dev)'}`,
  );
  if (env.provider === 'vertex' && hasVision) {
    console.log(
      `  Provider        →  Vertex AI (${env.gcpProject}, ${env.vertexLocation})\n`,
    );
  } else if (hasVision) {
    console.log('  Provider        →  AI Studio key\n');
  } else {
    console.warn(
      '\n  ⚠  Vision is not configured.\n' +
        '     On-device hazard alerts will still work, but scene narration will not.\n' +
        '     Set GOOGLE_CLOUD_PROJECT (Vertex AI) or GEMINI_API_KEY in .env\n',
    );
  }
  console.log(`  Live voice      →  ${env.liveModel} (${env.liveLocation}) at /api/live\n`);
});

injectWebSocket(server);
