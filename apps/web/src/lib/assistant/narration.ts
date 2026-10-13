/** Pure narration scheduler rules (testable, no DOM, no network). D1: regular updates every few seconds, never irritating, never identical repeats. */

export const NARRATION_TICK_MS = 6000;
export const FIND_TICK_MS = 2000;
export const FIND_CAP_MS = 60000;

/** Normalise for duplicate detection: case + punctuation + whitespace. */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function isDuplicate(lastSay: string, candidate: string): boolean {
  if (!lastSay || !candidate) return false;
  return norm(lastSay) === norm(candidate);
}

/** Should we skip this tick? Skip while speaking or while user is talking. */
export function shouldSkipTick(opts: { speaking: boolean; userTalking: boolean }): boolean {
  return opts.speaking || opts.userTalking;
}

/** Varied idle lines when nothing changed — rotate, never repeat twice. */
export const IDLE_LINES = [
  'Way ahead is clear.',
  'Still clear ahead, nothing new around you.',
  'Path continues ahead, nothing in your way.',
];

export function nextIdleLine(lastSay: string): string {
  for (const line of IDLE_LINES) if (!isDuplicate(lastSay, line)) return line;
  return IDLE_LINES[0]!;
}

/** Pick what to say: prefer fresh scene text, else varied idle line every other tick. */
export function pickUpdate(opts: {
  sceneSay: string;
  lastSay: string;
  tickCount: number;
  changed: boolean;
}): string | null {
  const clean = opts.sceneSay.trim();
  if (clean && !isDuplicate(opts.lastSay, clean)) return clean;
  // No change: speak a short varied path line at most every other tick.
  if (!opts.changed && opts.tickCount % 2 === 1) return nextIdleLine(opts.lastSay);
  return null;
}
