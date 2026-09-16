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

export const env = {
  geminiApiKey: process.env.GEMINI_API_KEY?.trim() ?? '',
  /**
   * Models to try, in order. The free tier allows only ~20 requests per day
   * *per model*, so listing more than one both multiplies the daily budget and
   * keeps the app alive when a model is retired — which already happened once
   * with gemini-2.5-flash.
   */
  geminiModels: (
    process.env.GEMINI_MODEL?.trim() ||
    'gemini-flash-lite-latest,gemini-3.1-flash-lite'
  )
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean),
  port: num(process.env.PORT, 8787),
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

export const hasGeminiKey = env.geminiApiKey.length > 0;
