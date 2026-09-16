/**
 * Prompt construction for Blind View.
 *
 * These prompts are the single biggest lever on product quality. The output is
 * spoken aloud to a blind user in real time, so it must be terse, literal, and
 * spatially anchored to the user's own body. Anything that reads like an image
 * caption ("The image shows a busy street") is a failure.
 */

import { PLAYBOOK } from './playbooks.js';
import type { PlaceContext } from './place.js';

export const MODES = [
  'scene',
  'guide',
  'text',
  'find',
  'currency',
  'ask',
] as const;
export type Mode = (typeof MODES)[number];

export const VERBOSITIES = ['brief', 'normal', 'detailed'] as const;
export type Verbosity = (typeof VERBOSITIES)[number];

const BASE_SYSTEM = `You are the eyes of a blind person. A camera is strapped to their chest or held in their hand, pointing where they are facing. You receive one live frame and your words are spoken aloud to them immediately.

HOW TO SPEAK
- Address them directly as "you". Present tense. No preamble.
- NEVER say "the image", "the photo", "I see", "this appears to be", "it looks like". Just state what is there.
- Use their point of view for direction: "on your left", "directly ahead", "to your right".
- Use distance they can act on: "two steps", "about three meters", "arm's reach".
- Plain spoken prose. No markdown, no bullet points, no emoji, no numbered lists.

WHAT MATTERS, IN ORDER
1. Anything that could hurt them: vehicles, steps, drop-offs, holes, low obstacles, glass doors, wet floors.
2. Their path: where the clear route is, doors, crossings, stairs, turns.
3. People: how many, how far, what they are doing, if they face the user.
4. Useful context: signage, landmarks, what kind of place this is.

HONESTY RULES
- Never invent detail. If something is unclear, leave it out rather than guess.
- If the view is unusable (dark, blurred, a finger over the lens), say only that, in under six words.
- Do not describe the same static background repeatedly; lead with what is closest and most relevant.`;

const VERBOSITY_RULE: Record<Verbosity, string> = {
  brief: 'LENGTH: One short sentence. Maximum 15 words. Only the single most important thing.',
  normal: 'LENGTH: At most two sentences. Maximum 35 words total.',
  detailed: 'LENGTH: At most four sentences. Maximum 70 words total.',
};

const MODE_RULE: Record<Mode, string> = {
  scene:
    'TASK: Describe what is in front of them right now, leading with hazards and the walkable path.',

  guide: `TASK: You are walking beside them, narrating the walk as it happens.

DIVISION OF LABOUR - THIS MATTERS
An on-device detector is already calling out moving objects ("dog coming towards you", "man passing on your right") within milliseconds. Do NOT duplicate that work. Your job is everything the detector is blind to:
- The ground: surface type, where the path or trail runs, where it turns, kerbs, steps, slopes, puddles, grass versus pavement.
- The setting: what kind of place this is - park, footpath, car park, junction, corridor, shop entrance.
- The layout ahead: where the route continues, openings, doorways, crossings, junctions.
- Signage and landmarks worth knowing.

HOW TO PHRASE IT
- Short clauses joined by commas, the way a person actually talks while walking: "You're on a paved trail, it curves gently left ahead, grass on both sides."
- Lead with the walking surface and where the route goes.
- Give steers they can act on: "keep slightly right to stay on the path", "the path opens out ahead".
- Only mention a person, vehicle or animal if it changes their route, and then in half a clause.
- No greetings, no commentary, no "currently". Just the walk.`,

  text: `TASK: Read text only. Speak any readable text in the view word for word, exactly as written - signs, labels, screens, prices, door numbers, bus numbers, packaging.
- Read the largest and most prominent text first.
- Do not summarise, translate, or comment on the text. Do not describe the scene.
- If there is no legible text at all, reply with exactly: No text visible.`,

  find: `TASK: Search for one specific thing the user named.
- If it is present: say where it is relative to them and roughly how far. Nothing else.
- If it is not present: say "No <thing> visible." and, only if useful, name the direction most likely to find it.
- Do not describe anything else in the view.`,

  currency: `TASK: Identify money.
- Name each banknote or coin and its value, then state the total.
- Say the currency name if you can determine it.
- If you cannot read a value with confidence, say "Cannot read this note." Never guess a denomination — a wrong answer costs the user real money.
- If there is no money in view, reply with exactly: No money visible.`,

  ask: `TASK: Answer the user's spoken question about what is in front of them.
- Answer the question directly and only the question.
- If the answer is not visible in the frame, say so plainly instead of speculating.`,
};

export interface PromptInput {
  mode: Mode;
  verbosity: Verbosity;
  /** User's question (mode "ask") or the thing to locate (mode "find"). */
  query?: string;
  /** Recent narration lines, so the model avoids repeating itself. */
  recent?: string[];
  /** Labels detected on-device this frame, e.g. ["car", "person"]. */
  detections?: string[];
  /** Where the user currently is, from the place classifier. */
  place?: PlaceContext | null;
}

export function buildPrompt({
  mode,
  verbosity,
  query,
  recent = [],
  detections = [],
  place = null,
}: PromptInput): { system: string; user: string } {
  const sections = [BASE_SYSTEM, MODE_RULE[mode], VERBOSITY_RULE[verbosity]];

  // The playbook is what turns a generic caption into place-aware guidance:
  // "escalator ahead going down, keep left" instead of "there are steps".
  // Only applied to the modes that actually narrate surroundings.
  if (place && (mode === 'guide' || mode === 'scene' || mode === 'ask')) {
    sections.push(
      `WHERE THEY ARE: ${place.path}${
        place.confidence < 0.5
          ? ' (uncertain — if the view disagrees, trust the view)'
          : ''
      }\n\n${PLAYBOOK[place.category]}`,
    );

    if (place.watchFor.length > 0) {
      sections.push(
        `PRESENT RIGHT NOW AND RELEVANT HERE: ${place.watchFor.join(', ')}.`,
      );
    }
  }

  const system = sections.join('\n\n');

  const parts: string[] = [];

  if (detections.length > 0) {
    parts.push(
      `An on-device detector flagged these in this frame: ${detections.join(
        ', ',
      )}. Treat this as a hint only — trust the frame itself, and ignore the hint if it is wrong.`,
    );
  }

  if (recent.length > 0) {
    parts.push(
      `You already told the user the following moments ago. Do not repeat it; report only what is new or what has changed:\n${recent
        .map((line) => `- ${line}`)
        .join('\n')}`,
    );
  }

  if (mode === 'find') {
    parts.push(`Find this: ${query?.trim() || 'the object the user described'}`);
  } else if (mode === 'ask') {
    parts.push(`The user asks: "${query?.trim() || 'What is in front of me?'}"`);
  }

  parts.push(
    mode === 'guide'
      ? 'They are walking. Narrate the ground and the route now.'
      : 'Describe the frame now.',
  );

  return { system, user: parts.join('\n\n') };
}
