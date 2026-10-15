/**
 * Find-mode loop state (pure helpers). Re-check ~2s, cap 60s, guided scan if not found.
 *
 * Honesty rule: never claim the object is found when it is not. The model's
 * `found` flag is the verdict; a direction sentence with found=false is a
 * guess and must never be spoken as a direction. When both the model and the
 * on-device detector agree the object is not in view, say so plainly and ask
 * the user to move the camera — like the Gemini app does.
 */

export interface FindState {
  target: string;
  startedAt: number;
  lastGuidance: string;
  found: boolean;
}

export function startFind(target: string, now = Date.now()): FindState {
  return { target: target.trim(), startedAt: now, lastGuidance: '', found: false };
}

export function findExpired(state: FindState, now = Date.now()): boolean {
  return now - state.startedAt >= 60000;
}

/** Guidance when target not in view: rotate scan slowly. */
export function scanGuidance(turn: number): string {
  const dirs = [
    "I can't see them yet. Slowly turn to your right.",
    "Still not in view. Slowly turn a little more to your right.",
    "Not yet. Now slowly turn to your left.",
  ];
  return dirs[turn % dirs.length]!;
}

export function isDuplicateGuidance(last: string, next: string): boolean {
  return last.trim().toLowerCase() === next.trim().toLowerCase();
}

/**
 * Not-in-view prompt. Alternates left / right on repeated misses so the user
 * sweeps the camera instead of holding it on the same empty view. The target
 * name is spoken as given ("your goggles", "your phone") — never a number.
 */
export function notInViewGuidance(target: string, turn: number): string {
  const side = turn % 2 === 0 ? 'left' : 'right';
  return `I can't see your ${target} yet. Move your camera slowly to the ${side}.`;
}

/** Does any on-device detector label look like the target? Fuzzy: "phone" matches "cell phone". */
export function matchesTarget(labels: string[], target: string): boolean {
  const words = target.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length === 0) return false;
  return labels.some((label) => {
    const l = label.toLowerCase();
    return words.every((w) => l.includes(w));
  });
}

export type FindDecision =
  | { action: 'found'; text: string }
  | { action: 'not-in-view'; text: string }
  | { action: 'hold'; text: string }
  | { action: 'say'; text: string }
  | { action: 'scan'; text: string };

/**
 * Pure decision for one Find tick. The controller speaks `text` (unless it
 * duplicates the last guidance) and stops only on 'found'.
 */
export function decideFindTick(opts: {
  target: string;
  /** Model verdict: true = visible, false = not visible, null = no verdict. */
  found: boolean | null | undefined;
  /** On-device detector sees something like the target. */
  detectorSees: boolean;
  /** Model's spoken line for this tick (may be empty). */
  say: string;
  /** Miss count, drives the left/right alternation. */
  turn: number;
}): FindDecision {
  const { target, found, detectorSees, say, turn } = opts;
  if (found === true) {
    return { action: 'found', text: say.trim() || `Found your ${target}.` };
  }
  if (found === false && !detectorSees) {
    // Both agree it is not in view: never speak a guessed direction.
    return { action: 'not-in-view', text: notInViewGuidance(target, turn) };
  }
  if (found === false && detectorSees) {
    // Detector disagrees with the model: don't claim a direction, ask to hold still.
    return { action: 'hold', text: `Hold steady. I think I can see something like your ${target}.` };
  }
  // No verdict: trust a fresh spoken line, else fall back to the scan prompt.
  if (say.trim()) return { action: 'say', text: say.trim() };
  return { action: 'scan', text: scanGuidance(turn) };
}
