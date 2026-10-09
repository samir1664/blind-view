import { env } from './env.js';
import { callGemini, SAFETY_SETTINGS, sanitize } from './gemini.js';
import { fillPlaceholders } from './geometry.js';
import type { Box } from './geometry.js';
import {
  buildScenePrompt,
  HEADINGS,
  OPEN_SIDE,
  PATH_STATUS,
  SCENE_CATEGORIES,
  SCENE_SCHEMA,
  STEP,
  TRAFFIC,
} from './scenePrompts.js';
import type { ScenePromptInput, SceneTask } from './scenePrompts.js';

export { buildScenePrompt } from './scenePrompts.js';

export interface SceneObject {
  id: string;
  label: string;
  box_2d: Box;
  moving: boolean;
  heading: (typeof HEADINGS)[number];
  hazard: boolean;
}

export interface SceneFacts {
  place: {
    environment: 'indoor' | 'outdoor';
    category: (typeof SCENE_CATEGORIES)[number];
    specific: string;
    traffic: (typeof TRAFFIC)[number];
  };
  path: {
    status: (typeof PATH_STATUS)[number];
    surface: string;
    open_side: (typeof OPEN_SIDE)[number];
  };
  objects: SceneObject[];
  text: string[];
  found: boolean | null;
  step: (typeof STEP)[number] | null;
}

export interface ParsedScene {
  say: string;
  facts: SceneFacts;
}

const MAX_OBJECTS = 8;

function oneOf<T extends string>(values: readonly T[], value: unknown, fallback: T): T {
  return values.includes(value as T) ? (value as T) : fallback;
}

function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function clampBox(value: unknown): Box | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const n = value.map((v) => Math.max(0, Math.min(1000, Number(v))));
  if (n.some((v) => !Number.isFinite(v))) return null;
  const [a, b, c, d] = n as [number, number, number, number];
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
}

/** Validate and clamp the model's JSON. A bad reply must never break speech. */
export function parseSceneResponse(raw: string): ParsedScene {
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
  } catch {
    data = {};
  }

  const place = (data.place ?? {}) as Record<string, unknown>;
  const path = (data.path ?? {}) as Record<string, unknown>;

  const objects: SceneObject[] = [];
  if (Array.isArray(data.objects)) {
    for (const item of data.objects) {
      if (objects.length >= MAX_OBJECTS) break;
      if (!item || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      const box = clampBox(o.box_2d);
      const id = str(o.id, 12).replace(/[^A-Za-z0-9-]/g, '');
      if (!box || !id) continue;
      objects.push({
        id,
        label: str(o.label, 48) || 'object',
        box_2d: box,
        moving: o.moving === true,
        heading: oneOf(HEADINGS, o.heading, 'unknown'),
        hazard: o.hazard === true,
      });
    }
  }

  return {
    say: str(data.say, 1200),
    facts: {
      place: {
        environment: place.environment === 'outdoor' ? 'outdoor' : 'indoor',
        category: oneOf(SCENE_CATEGORIES, place.category, 'other'),
        specific: str(place.specific, 60),
        traffic: oneOf(TRAFFIC, place.traffic, 'none'),
      },
      path: {
        status: oneOf(PATH_STATUS, path.status, 'unknown'),
        surface: str(path.surface, 40),
        open_side: oneOf(OPEN_SIDE, path.open_side, 'none'),
      },
      objects,
      text: Array.isArray(data.text)
        ? data.text.map((t) => str(t, 300)).filter(Boolean).slice(0, 20)
        : [],
      found: typeof data.found === 'boolean' ? data.found : null,
      step: data.step === undefined ? null : oneOf(STEP, data.step, 'unsure'),
    },
  };
}

const OPEN_WORDS: Record<(typeof OPEN_SIDE)[number], string> = {
  left: 'to your left',
  right: 'to your right',
  both: 'on both sides',
  none: '',
};

/** The final spoken sentence: markdown stripped, directions filled by geometry. */
export function finaliseSay(scene: ParsedScene, mirrored: boolean): string {
  let side = scene.facts.path.open_side;
  if (mirrored && (side === 'left' || side === 'right')) {
    side = side === 'left' ? 'right' : 'left';
  }
  const withOpen = sanitize(scene.say).replace(/\{open\}/g, OPEN_WORDS[side]);
  return fillPlaceholders(withOpen, scene.facts.objects, mirrored);
}

export const NO_TEXT_SAY =
  "I can't read any text yet. Hold the phone a little further away and keep it steady.";

/**
 * Task-level guarantees the prompt alone cannot be trusted with. Reading is
 * where models most often answer confidently about something else, so an
 * empty text list always yields the same honest instruction.
 */
export function speechFor(task: SceneTask, scene: ParsedScene, mirrored: boolean): string {
  if (task === 'read' && scene.facts.text.length === 0) return NO_TEXT_SAY;
  return finaliseSay(scene, mirrored);
}

export interface AnalyzeArgs extends ScenePromptInput {
  imageBase64: string;
  mimeType: string;
  mirrored: boolean;
}

export interface SceneResult {
  say: string;
  facts: SceneFacts;
}

export async function analyzeScene(args: AnalyzeArgs): Promise<SceneResult> {
  const { system, user } = buildScenePrompt(args);
  const raw = await callGemini(
    {
      systemInstruction: { parts: [{ text: system }] },
      contents: [
        {
          role: 'user',
          parts: [{ text: user }, { inlineData: { mimeType: args.mimeType, data: args.imageBase64 } }],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: args.task === 'read' ? 2048 : 1400,
        responseMimeType: 'application/json',
        responseSchema: SCENE_SCHEMA,
        thinkingConfig: { thinkingLevel: env.sceneThinking },
      },
      safetySettings: SAFETY_SETTINGS,
    },
    15_000,
    env.sceneModels,
  );

  const parsed = parseSceneResponse(raw);
  return { say: speechFor(args.task, parsed, args.mirrored), facts: parsed.facts };
}
