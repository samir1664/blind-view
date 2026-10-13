/** Find-mode loop state (pure helpers). Re-check ~2s, cap 60s, guided scan if not found. */

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
