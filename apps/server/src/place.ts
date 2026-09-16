import { callGemini, SAFETY_SETTINGS, sanitize } from './gemini.js';
import {
  CATEGORY_HINT,
  ENVIRONMENTS,
  PLACE_CATEGORIES,
} from './playbooks.js';
import type { Environment, PlaceCategory } from './playbooks.js';

/**
 * The place classifier.
 *
 * Runs on its own slow cadence — roughly once every 10–15 seconds, or when the
 * view changes a lot — and answers one question: *where is this person?*
 *
 * Splitting it out from narration is what makes the whole approach affordable.
 * "What kind of place is this" is a stable, expensive question; "what is in
 * front of me right now" is a cheap, volatile one. Answer the first rarely and
 * reuse it to sharpen the second.
 */

export interface PlaceContext {
  environment: Environment;
  category: PlaceCategory;
  /** The specific spot, e.g. "kitchen", "escalator landing", "zebra crossing". */
  place: string;
  confidence: number;
  /** A short line to speak when the place changes. */
  announcement: string;
  /** Place-specific things present right now that deserve attention. */
  watchFor: string[];
  /** Human-readable hierarchy: "outdoor > road > zebra crossing". */
  path: string;
}

const SYSTEM = `You identify where a blind person currently is, from a single camera frame, so that a narration system can use the right vocabulary and the right hazards.

Work from the broadest category down to the most specific spot:
  indoor > home > kitchen
  indoor > mall > escalator landing
  indoor > hospital > waiting area
  outdoor > road > pedestrian crossing
  outdoor > park > gravel trail

RULES
- Choose the category that best matches, from this fixed list: ${CATEGORY_HINT}.
- "place" is the specific spot in plain words, two or three words at most.
- "announcement" is one short spoken sentence telling the user where they are, addressed as "you", e.g. "You're in a kitchen, at the worktop." or "You're on a road, at a pedestrian crossing." Maximum 12 words.
- "watchFor" lists up to three things visible right now that matter in THIS kind of place — a platform edge, an escalator, a kerb, a hot ring, a wet floor. Use plain short phrases. Empty list if nothing stands out.
- "confidence" is honest: below 0.5 if you are guessing. If you truly cannot tell, use category "other" with low confidence.
- Judge only from what is visible. Never infer a place from a single object alone.`;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    environment: { type: 'STRING', enum: [...ENVIRONMENTS] },
    category: { type: 'STRING', enum: [...PLACE_CATEGORIES] },
    place: { type: 'STRING' },
    confidence: { type: 'NUMBER' },
    announcement: { type: 'STRING' },
    watchFor: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: [
    'environment',
    'category',
    'place',
    'confidence',
    'announcement',
    'watchFor',
  ],
  propertyOrdering: [
    'environment',
    'category',
    'place',
    'confidence',
    'announcement',
    'watchFor',
  ],
};

export interface ClassifyArgs {
  imageBase64: string;
  mimeType: string;
  /** The last known place, to discourage pointless flip-flopping. */
  previous?: PlaceContext | null;
  detections?: string[];
}

export async function classifyPlace({
  imageBase64,
  mimeType,
  previous,
  detections = [],
}: ClassifyArgs): Promise<PlaceContext> {
  const hints: string[] = [];

  if (detections.length > 0) {
    hints.push(`Objects detected on-device: ${detections.join(', ')}.`);
  }
  if (previous) {
    hints.push(
      `Moments ago they were in: ${previous.path}. Keep that classification unless the view clearly shows somewhere different — places do not usually change every few seconds.`,
    );
  }
  hints.push('Identify where they are now.');

  const raw = await callGemini(
    {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [
        {
          role: 'user',
          parts: [
            { text: hints.join('\n\n') },
            { inlineData: { mimeType, data: imageBase64 } },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 400,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
        thinkingConfig: { thinkingLevel: 'low' },
      },
      safetySettings: SAFETY_SETTINGS,
    },
    // Structured output is noticeably slower than free-form text. This loop
    // runs every 20 seconds and nothing waits on it, so it can afford to be
    // patient rather than fail and leave narration without place context.
    25_000,
  );

  return normalize(raw, previous);
}

function normalize(raw: string, previous?: PlaceContext | null): PlaceContext {
  let parsed: Partial<PlaceContext> = {};
  try {
    parsed = JSON.parse(raw) as Partial<PlaceContext>;
  } catch {
    // Structured output should make this impossible, but a malformed reply
    // must never take down narration.
    parsed = {};
  }

  const environment: Environment = ENVIRONMENTS.includes(
    parsed.environment as Environment,
  )
    ? (parsed.environment as Environment)
    : (previous?.environment ?? 'outdoor');

  const category: PlaceCategory = PLACE_CATEGORIES.includes(
    parsed.category as PlaceCategory,
  )
    ? (parsed.category as PlaceCategory)
    : 'other';

  const place = sanitize(String(parsed.place ?? '')).slice(0, 40) || category;

  const confidence = clamp01(Number(parsed.confidence));

  const watchFor = Array.isArray(parsed.watchFor)
    ? parsed.watchFor
        .filter((item): item is string => typeof item === 'string')
        .slice(0, 3)
        .map((item) => sanitize(item).slice(0, 48))
        .filter(Boolean)
    : [];

  const announcement =
    sanitize(String(parsed.announcement ?? '')).slice(0, 140) ||
    `You're in a ${place}.`;

  return {
    environment,
    category,
    place,
    confidence,
    announcement,
    watchFor,
    path: `${environment} > ${category} > ${place}`,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}
