/**
 * Prompts and response schema for /api/scene.
 *
 * One structured call per question. The model reports WHAT is there and marks
 * WHERE direction or nearness belongs with placeholders; geometry.ts turns the
 * boxes into words. Every word of `say` is spoken to a blind person, so the
 * rules below are about being useful, brief, and never misleading.
 */

export const SCENE_TASKS = [
  'orient',
  'update',
  'find',
  'read',
  'ask',
  'verify_step',
] as const;
export type SceneTask = (typeof SCENE_TASKS)[number];

export const SCENE_CATEGORIES = [
  'home',
  'office',
  'shop',
  'mall',
  'restaurant',
  'hospital',
  'school',
  'station',
  'road',
  'footpath',
  'park',
  'forest',
  'market',
  'parking',
  'room',
  'other',
] as const;

export const TRAFFIC = ['none', 'light', 'moderate', 'heavy'] as const;
export const PATH_STATUS = ['clear', 'narrowing', 'blocked', 'unknown'] as const;
export const OPEN_SIDE = ['left', 'right', 'both', 'none'] as const;
export const HEADINGS = [
  'towards',
  'away',
  'crossing_left',
  'crossing_right',
  'static',
  'unknown',
] as const;
export const STEP = ['none', 'up', 'down', 'unsure'] as const;

export type Verbosity = 'brief' | 'normal' | 'detailed';

export interface ScenePromptInput {
  task: SceneTask;
  query?: string;
  /** What was last said to the user, so updates report change, not repeats. */
  previous?: string;
  /** On-device observations since the last update, e.g. "person passed on the left". */
  localEvents?: string[];
  walking?: boolean;
  verbosity?: Verbosity;
}

const BASE = `You are the eyes of a blind person. A phone camera points where they are facing. You receive one frame. Fill the JSON schema. The "say" field is spoken aloud to them immediately.

OBJECTS
- List up to 8 objects that matter to a blind person here: people, animals, vehicles, doors, stairs, kerbs, poles, obstacles in or near the walking path, furniture close by, signs. Skip background clutter.
- id: short and unique, like o1, o2. label: plain words ("man with a bag", "parked scooter", "glass door").
- box_2d: [ymin, xmin, ymax, xmax] normalised 0-1000.
- moving: true only if it is clearly in motion (motion blur, mid-stride, wheels on the road with traffic flowing). heading is relative to the camera. From a single frame you usually CANNOT know whether something comes closer or goes away: use "towards" or "away" only when it is obvious (a person facing the camera mid-stride towards it), otherwise "unknown". Parked or standing things are "static".
- In "say", never claim something is coming towards them or moving away unless the on-device detector events below say so. Describe what it is doing instead (walking, standing, parked, riding).
- hazard: true only if it could hurt or trip them soon.

HOW TO WRITE "say"
- Never write left, right, ahead, clock positions, metres, steps, or any numbers for position or distance yourself — never state metres or numbers. Instead write {dir:ID} exactly where a direction belongs and {near:ID} where nearness belongs, using an id from "objects". Example: "A man is walking towards you {dir:o1}, {near:o1}." Write {open} where the open side of the path belongs, e.g. "The way is open {open}."
- Use each placeholder at most once per object, and never add your own nearness words (near, close, far) next to {near:ID} — the placeholder already says it.
- Address them as "you". Present tense. Plain full sentences. No markdown, no lists.
- Never say "image", "photo", "picture", "I see", "it looks like".
- Never invent. If something is unclear, leave it out or say briefly that you are not sure.
- No generic caution ("be careful", "stay safe"), no cheerfulness, no filler.
- Never tell them it is safe to cross a road. Never tell them to look at something or to ask someone.`;

const TASK_RULES: Record<SceneTask, string> = {
  orient: `TASK: ORIENTATION. They have just started. Describe the place first: what kind of place it is, if outdoors how heavy the traffic is, the overall layout, and where the walking path goes. Then the one most important thing near them. Start with "You are in", "You are at" or "You are on".`,
  update: `TASK: LIVE UPDATE during a walk. Report what CHANGED since the previous update: people, animals or vehicles moving and what they are doing (coming towards them, passing, crossing), a change in the path or the place. If nothing important changed, give ONE short line about the path that is worded differently from the previous update. Do not repeat the previous update.`,
  find: `TASK: FIND the object the user asked for. If it is visible, set found=true, include it in objects with id "t", and say where it is using {dir:t} and {near:t}, plus what it is on or next to. If it is not visible, set found=false and say it is not visible, then suggest slowly turning the phone or tilting it up or down. Do not describe anything else.`,
  read: `TASK: READ TEXT ONLY. Put every legible piece of text in "text", largest first. In "say", read it word for word exactly as written — numbers, prices, doses included. Do not summarise, translate, or describe the scene. If nothing is legible, leave "text" empty.`,
  ask: `TASK: ANSWER the user's question about what is in front of them, directly and only that. If the answer is not visible, say so plainly. Do not change a correct answer because the question pushes you to.`,
  verify_step: `TASK: CHECK THE GROUND. Look only at the walking surface directly ahead within a few steps. Set step to "up" or "down" only if there is clearly a step, kerb, stair or drop-off; "none" if the ground is level; "unsure" otherwise. If up or down, include the edge as object id "s" and say e.g. "Step down {near:s}." Otherwise leave say empty.`,
};

const LENGTH: Record<SceneTask, Record<Verbosity, string>> = {
  orient: { brief: 'max 25 words', normal: 'max 45 words', detailed: 'max 70 words' },
  update: { brief: 'max 15 words', normal: 'max 28 words', detailed: 'max 40 words' },
  find: { brief: 'max 20 words', normal: 'max 25 words', detailed: 'max 35 words' },
  read: { brief: 'no limit', normal: 'no limit', detailed: 'no limit' },
  ask: { brief: 'max 25 words', normal: 'max 40 words', detailed: 'max 60 words' },
  verify_step: { brief: 'max 8 words', normal: 'max 8 words', detailed: 'max 8 words' },
};

function clean(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function buildScenePrompt(input: ScenePromptInput): { system: string; user: string } {
  const verbosity = input.verbosity ?? 'normal';
  const system = [BASE, TASK_RULES[input.task], `LENGTH of "say": ${LENGTH[input.task][verbosity]}.`].join('\n\n');

  const parts: string[] = [];
  if (input.walking !== undefined) {
    parts.push(input.walking ? 'They are walking.' : 'They are standing still.');
  }
  if (input.previous) {
    parts.push(`Previous update spoken to them: "${clean(input.previous, 400)}"`);
  }
  if (input.localEvents?.length) {
    parts.push(
      `On-device detector since then (hints only, trust the frame): ${input.localEvents
        .slice(0, 6)
        .map((e) => clean(e, 80))
        .join('; ')}.`,
    );
  }
  if (input.task === 'find') {
    parts.push(`Find: ${clean(input.query || 'the object they described', 80)}`);
  } else if (input.task === 'ask') {
    parts.push(`Their question: "${clean(input.query || 'What is in front of me?', 200)}"`);
  }
  parts.push('Analyse the frame now.');

  return { system, user: parts.join('\n') };
}

const STRING = { type: 'STRING' };
const BOOLEAN = { type: 'BOOLEAN' };
const enumOf = (values: readonly string[]) => ({ type: 'STRING', enum: [...values] });

export const SCENE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    objects: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: STRING,
          label: STRING,
          box_2d: { type: 'ARRAY', items: { type: 'INTEGER' } },
          moving: BOOLEAN,
          heading: enumOf(HEADINGS),
          hazard: BOOLEAN,
        },
        required: ['id', 'label', 'box_2d', 'moving', 'heading', 'hazard'],
      },
    },
    place: {
      type: 'OBJECT',
      properties: {
        environment: enumOf(['indoor', 'outdoor']),
        category: enumOf(SCENE_CATEGORIES),
        specific: STRING,
        traffic: enumOf(TRAFFIC),
      },
      required: ['environment', 'category', 'specific', 'traffic'],
    },
    path: {
      type: 'OBJECT',
      properties: {
        status: enumOf(PATH_STATUS),
        surface: STRING,
        open_side: enumOf(OPEN_SIDE),
      },
      required: ['status', 'surface', 'open_side'],
    },
    text: { type: 'ARRAY', items: STRING },
    found: BOOLEAN,
    step: enumOf(STEP),
    say: STRING,
  },
  required: ['objects', 'place', 'path', 'say'],
  propertyOrdering: ['objects', 'place', 'path', 'text', 'found', 'step', 'say'],
};
