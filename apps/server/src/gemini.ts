import { env } from './env.js';
import type { Mode, Verbosity } from './prompts.js';

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Upper bound on generated tokens.
 *
 * Careful: on Gemini 3.x, internal "thinking" tokens are charged against
 * maxOutputTokens. A budget sized only for the visible answer produces a reply
 * that stops mid-sentence with finishReason MAX_TOKENS. These numbers include
 * roughly 80 tokens of headroom for thinking on top of the spoken text.
 */
const MAX_TOKENS: Record<Verbosity, number> = {
  brief: 200,
  normal: 320,
  detailed: 480,
};

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'GeminiError';
  }
}

interface GeminiPart {
  text?: string;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string };
}

/** Safety thresholds. Street scenes and medical labels trip conservative
 *  filters, so only clear-cut high-confidence harm is blocked. */
export const SAFETY_SETTINGS = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' }));

/**
 * Shared HTTP transport for every Gemini call, with uniform error mapping.
 *
 * Tries each configured model in turn. A model is skipped and the next tried
 * when it is retired (404) or out of free-tier quota (429) — on the free tier
 * the daily allowance is per-model, so this is the difference between the app
 * working and not.
 *
 * Returns the raw text of the first candidate.
 */
export async function callGemini(
  body: unknown,
  timeoutMs = 15_000,
): Promise<string> {
  let lastError: GeminiError | null = null;

  for (const model of env.geminiModels) {
    try {
      return await callModel(model, body, timeoutMs);
    } catch (error) {
      if (!(error instanceof GeminiError)) throw error;
      lastError = error;
      // Only these two mean "this model cannot serve us — try another".
      // Anything else is a real failure and must surface immediately.
      if (error.status !== 429 && error.status !== 404) throw error;
    }
  }

  throw lastError ?? new GeminiError('No vision model is configured.', 500, false);
}

async function callModel(
  model: string,
  body: unknown,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(
      `${API_ROOT}/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': env.geminiApiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw new GeminiError('Vision request timed out.', 504, true);
    }
    throw new GeminiError('Cannot reach the vision service.', 502, true);
  } finally {
    clearTimeout(timer);
  }

  const payload = (await response.json().catch(() => ({}))) as GeminiResponse;

  if (!response.ok) {
    const detail = payload.error?.message ?? response.statusText;
    if (response.status === 400 && /API key/i.test(detail)) {
      throw new GeminiError('Invalid GEMINI_API_KEY.', 401, false);
    }
    if (response.status === 404) {
      throw new GeminiError(`Model ${model} is unavailable.`, 404, false);
    }
    if (response.status === 429) {
      throw new GeminiError(
        'Daily free-tier quota is used up. Enable billing or try tomorrow.',
        429,
        true,
      );
    }
    if (response.status === 503) {
      throw new GeminiError('The vision service is busy.', 503, true);
    }
    throw new GeminiError(
      `Vision service error: ${detail}`,
      response.status >= 500 ? 502 : response.status,
      response.status >= 500,
    );
  }

  if (payload.promptFeedback?.blockReason) {
    throw new GeminiError('This view could not be described.', 422, false);
  }

  const candidate = payload.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .map((part) => part.text ?? '')
    .join('')
    .trim();

  if (!text) {
    if (candidate?.finishReason === 'SAFETY') {
      throw new GeminiError('This view could not be described.', 422, false);
    }
    if (candidate?.finishReason === 'MAX_TOKENS') {
      // All of the budget went to thinking and nothing was left to say.
      throw new GeminiError('The description was cut short.', 502, true);
    }
    throw new GeminiError('No description was produced.', 502, true);
  }

  return text;
}

export interface GenerateArgs {
  system: string;
  user: string;
  imageBase64: string;
  mimeType: string;
  mode: Mode;
  verbosity: Verbosity;
  timeoutMs?: number;
}

/**
 * Flash models are periodically capacity-constrained and answer 503. One fast
 * retry recovers most of those. Timeouts are deliberately NOT retried: the
 * latency budget is already spent, and stale narration is worse than silence.
 */
const RETRY_BACKOFF_MS = 400;

export async function generateDescription(args: GenerateArgs): Promise<string> {
  try {
    return await attempt(args);
  } catch (error) {
    if (error instanceof GeminiError && error.status === 503) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
      return attempt(args);
    }
    throw error;
  }
}

async function attempt({
  system,
  user,
  imageBase64,
  mimeType,
  mode,
  verbosity,
  timeoutMs = 15_000,
}: GenerateArgs): Promise<string> {
  const text = await callGemini(
    {
      systemInstruction: { parts: [{ text: system }] },
      contents: [
        {
          role: 'user',
          parts: [{ text: user }, { inlineData: { mimeType, data: imageBase64 } }],
        },
      ],
      generationConfig: {
        // Low temperature: we want literal reporting, not creative writing.
        temperature: 0.15,
        topP: 0.9,
        // OCR is the one mode where truncation loses real information.
        maxOutputTokens: mode === 'text' ? 900 : MAX_TOKENS[verbosity],
        // The single biggest latency lever. Measured on a live scene frame:
        // "low" answers in ~2 s, while leaving thinking unconstrained took
        // 26–43 s and still truncated. Note "none" is rejected by the API.
        thinkingConfig: { thinkingLevel: 'low' },
      },
      safetySettings: SAFETY_SETTINGS,
    },
    timeoutMs,
  );

  return sanitize(text);
}

/**
 * The output goes straight into a speech synthesizer, which reads punctuation
 * like `*` and `#` aloud or chokes on it. Strip anything non-spoken.
 */
export function sanitize(text: string): string {
  return text
    .replace(/[*_`#]+/g, '')
    .replace(/^\s*[-•]\s*/gm, '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
