import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Load .env from the repo root (two levels up from apps/server/src),
// falling back to a local .env inside apps/server.
for (const candidate of [
  resolve(here, '../../../.env'),
  resolve(here, '../.env'),
]) {
  if (existsSync(candidate)) {
    config({ path: candidate });
    break;
  }
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export type Provider = 'vertex' | 'aistudio';

/**
 * Vertex AI is the default whenever a Google Cloud project is configured: it is
 * covered by Cloud credits and has no per-day request cap. The AI Studio key
 * remains as a zero-setup fallback for local development.
 */
export function resolveProvider(
  raw: string | undefined,
  project: string,
): Provider {
  const value = raw?.trim().toLowerCase();
  if (value === 'vertex' || value === 'aistudio') return value;
  return project ? 'vertex' : 'aistudio';
}

const gcpProject = (
  process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT ?? ''
).trim();

export const env = {
  provider: resolveProvider(process.env.GEMINI_PROVIDER, gcpProject),
  gcpProject,
  /** `global` gives the widest model availability for generateContent. */
  vertexLocation: process.env.VERTEX_LOCATION?.trim() || 'global',
  geminiApiKey: process.env.GEMINI_API_KEY?.trim() ?? '',
  /**
   * Models to try, in order. A model is skipped when it is retired (404) or
   * out of quota (429), so listing more than one keeps narration alive.
   */
  geminiModels: (
    process.env.GEMINI_MODEL?.trim() ||
    'gemini-3.5-flash-lite,gemini-3.1-flash-lite'
  )
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean),
  /**
   * Model for structured scene analysis (/api/scene). Benchmarked 2026-10-09 on
   * street/home/office photos: 3.5 Flash-Lite answers in ~2.7-3.6 s with correct
   * place, traffic and sides; 3.5 Flash and 3.8 Flash took 7-15 s or timed out.
   */
  sceneModels: (process.env.SCENE_MODEL?.trim() || 'gemini-3.5-flash-lite,gemini-3.1-flash-lite')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean),
  /** Thinking level for scene analysis: minimal | low | medium. Latency lever. */
  sceneThinking: process.env.SCENE_THINKING?.trim() || 'low',
  /** Gemini Live (voice). Only us-central1 serves it for this project (probed 2026-10-09). */
  liveLocation: process.env.LIVE_LOCATION?.trim() || 'us-central1',
  liveModel: process.env.LIVE_MODEL?.trim() || 'gemini-live-2.5-flash-native-audio',
  liveVoice: process.env.LIVE_VOICE?.trim() || 'Aoede',
  liveMaxMinutes: num(process.env.LIVE_MAX_MINUTES, 30),
  port: num(process.env.PORT, 8788),
  /** Require Firebase App Check + ID tokens on paid endpoints. On in production. */
  requireAppCheck: process.env.REQUIRE_APP_CHECK?.trim() === 'true',
  rateLimitPerMin: num(process.env.RATE_LIMIT_PER_MIN, 60),
  maxImageKb: num(process.env.MAX_IMAGE_KB, 2048),
  allowedOrigins: (
    process.env.ALLOWED_ORIGINS ||
    'http://localhost:5173,http://127.0.0.1:5173'
  )
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
};
