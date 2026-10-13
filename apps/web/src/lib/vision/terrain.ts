import type { DepthMap } from './depth';
import type { Zone } from '../../types';

/**
 * Reads the ground out of a depth map.
 *
 * This closes the gap the object detector cannot: COCO-SSD knows 80 classes,
 * and "kerb", "step", "pothole" and "drop-off" are none of them. Depth sees
 * shape rather than category, so it catches the unnamed things that actually
 * trip people.
 *
 * Two readings come out of each frame:
 *
 *  1. LANE OPENNESS — how near the closest surface is in the left, centre and
 *     right thirds. Works for walls, hedges, poles, parked cars, glass — any
 *     obstacle, named or not.
 *
 *  2. GROUND DISCONTINUITY — walking up the centre of the frame, a flat floor
 *     recedes smoothly. A sudden jump in the profile means the ground broke:
 *     away from the camera is a step down or drop, toward it is a step up.
 *
 * Everything here is RELATIVE. Depth Anything predicts inverse depth with no
 * metric scale, so these comparisons are only valid within a single frame, and
 * nothing in this file may ever be phrased to the user as a distance.
 */

/** Lane boundaries, matching `zoneFor` in spatial.ts. */
const LEFT_EDGE = 0.35;
const RIGHT_EDGE = 0.65;

/** Rows examined for obstacles: the walkable band ahead of the user. */
const BAND_TOP = 0.5;
const BAND_BOTTOM = 0.92;

/** Normalised nearness above which a lane counts as obstructed. */
const BLOCKED_THRESHOLD = 0.72;

/**
 * How far above its row baseline a surface must sit to count as fully
 * obstructing. In normalised inverse-depth units.
 */
const OBSTACLE_EXCESS_SCALE = 0.35;

/** Minimum normalised jump between adjacent profile rows to call it a step. */
const STEP_THRESHOLD = 0.055;

/** Rows are smoothed over this many neighbours before differentiating. */
const SMOOTH_RADIUS = 2;

export interface TerrainStep {
  kind: 'up' | 'down';
  /** 0 = top of frame (far), 1 = bottom (at the user's feet). */
  rowFraction: number;
  /** How pronounced the discontinuity is, in normalised depth units. */
  strength: number;
}

export interface TerrainReport {
  /** 0 = fully blocked, 1 = wide open. */
  openness: Record<Zone, number>;
  clearest: Zone;
  aheadBlocked: boolean;
  step: TerrainStep | null;
  phrase: string | null;
  urgency: number;
}

/** Step candidate must persist ≥3 frames at consistent position before verify_step. Unconfirmed = silent. */
export class StepCandidateTracker {
  private count = 0;
  private lastKind: 'up' | 'down' | null = null;
  private lastRow = 0;
  update(step: TerrainStep | null): TerrainStep | null {
    if (!step) { this.count = 0; this.lastKind = null; return null; }
    if (this.lastKind === step.kind && Math.abs(this.lastRow - step.rowFraction) < 0.08) {
      this.count += 1;
    } else {
      this.count = 1; this.lastKind = step.kind; this.lastRow = step.rowFraction;
    }
    this.lastRow = step.rowFraction;
    return this.count >= 3 ? step : null;
  }
  reset(): void { this.count = 0; this.lastKind = null; }
}

export function analyzeTerrain(map: DepthMap): TerrainReport | null {
  const { data, size } = map;
  if (!size || data.length < size * size) return null;

  // Depth is relative and its range drifts frame to frame, so normalise
  // against this frame's own spread before thresholding anything.
  const { low, high } = robustRange(data);
  const span = high - low;
  if (span <= 1e-6) return null;

  const norm = (value: number) =>
    Math.max(0, Math.min(1, (value - low) / span));

  const rowStart = Math.floor(size * BAND_TOP);
  const rowEnd = Math.floor(size * BAND_BOTTOM);

  const openness = {
    left: laneOpenness(data, size, rowStart, rowEnd, 0, LEFT_EDGE, norm),
    ahead: laneOpenness(data, size, rowStart, rowEnd, LEFT_EDGE, RIGHT_EDGE, norm),
    right: laneOpenness(data, size, rowStart, rowEnd, RIGHT_EDGE, 1, norm),
  } satisfies Record<Zone, number>;
  const clearest = (['ahead', 'left', 'right'] as Zone[]).reduce((best, zone) =>
    openness[zone] > openness[best] ? zone : best,
  );

  const aheadBlocked = openness.ahead < 1 - BLOCKED_THRESHOLD;
  const step = findStep(data, size, norm);

  // F1/F2/F5: local layer never speaks path/step status directly. Step is a
  // candidate only — caller must confirm via StepCandidateTracker (≥3 frames)
  // + /api/scene verify_step before speaking. Path status is context for narrator.
  const phrase: string | null = null;
  const urgency = 0;

  return { openness, clearest, aheadBlocked, step, phrase, urgency };
}

/**
 * How open a lane is.
 *
 * Measured as how much NEARER the lane is than the rest of that same image
 * row, not as absolute nearness. This distinction matters: the floor directly
 * at your feet is always the nearest surface in the frame, so an absolute
 * measure declares clear ground to be an obstacle. Comparing against the row's
 * own baseline asks the right question — is something sticking out closer than
 * the ground should be at this distance?
 *
 * Caveat: an obstruction spanning the full width (a wall straight across)
 * shifts the baseline with it and reads as open. That case is caught by the
 * ground-discontinuity check instead.
 */
function laneOpenness(
  data: Float32Array,
  size: number,
  rowStart: number,
  rowEnd: number,
  fromRatio: number,
  toRatio: number,
  norm: (value: number) => number,
): number {
  const x0 = Math.floor(size * fromRatio);
  const x1 = Math.max(x0 + 1, Math.floor(size * toRatio));

  const excesses: number[] = [];

  for (let y = rowStart; y < rowEnd; y += 1) {
    const rowOffset = y * size;

    const whole: number[] = [];
    for (let x = 0; x < size; x += 2) whole.push(norm(data[rowOffset + x] ?? 0));
    if (whole.length === 0) continue;
    whole.sort((a, b) => a - b);
    const baseline = whole[Math.floor(whole.length / 2)] ?? 0;

    const lane: number[] = [];
    for (let x = x0; x < x1; x += 2) lane.push(norm(data[rowOffset + x] ?? 0));
    if (lane.length === 0) continue;
    lane.sort((a, b) => a - b);
    const laneMedian = lane[Math.floor(lane.length / 2)] ?? 0;

    excesses.push(laneMedian - baseline);
  }

  if (excesses.length === 0) return 1;

  // The worst few rows decide it, but not the single worst pixel row.
  excesses.sort((a, b) => a - b);
  const excess = excesses[Math.floor(excesses.length * 0.85)] ?? 0;

  return 1 - Math.max(0, Math.min(1, excess / OBSTACLE_EXCESS_SCALE));
}

/**
 * Walk the centre column from the user's feet upward and look for the ground
 * profile to break.
 */
function findStep(
  data: Float32Array,
  size: number,
  norm: (value: number) => number,
): TerrainStep | null {
  const x0 = Math.floor(size * 0.4);
  const x1 = Math.floor(size * 0.6);

  const rowStart = Math.floor(size * 0.55);
  const rowEnd = Math.floor(size * 0.97);

  const profile: number[] = [];
  for (let y = rowStart; y < rowEnd; y += 1) {
    const row: number[] = [];
    for (let x = x0; x < x1; x += 1) row.push(norm(data[y * size + x] ?? 0));
    row.sort((a, b) => a - b);
    profile.push(row[Math.floor(row.length / 2)] ?? 0);
  }

  const smoothed = smooth(profile, SMOOTH_RADIUS);
  if (smoothed.length < 6) return null;

  // Ignore the outermost samples: they are the smoothing window's ragged edge.
  let bestIndex = -1;
  let bestDelta = 0;
  for (let i = SMOOTH_RADIUS + 1; i < smoothed.length - SMOOTH_RADIUS - 1; i += 1) {
    const delta = (smoothed[i] ?? 0) - (smoothed[i - 1] ?? 0);
    if (Math.abs(delta) > Math.abs(bestDelta)) {
      bestDelta = delta;
      bestIndex = i;
    }
  }

  if (bestIndex < 0 || Math.abs(bestDelta) < STEP_THRESHOLD) return null;

  const rowFraction = (rowStart + bestIndex) / size;

  // Moving up the image means moving away from the user. Nearness increasing
  // as we go up means a surface rising toward them; falling means the ground
  // drops away.
  return {
    kind: bestDelta > 0 ? 'down' : 'up',
    rowFraction,
    strength: Math.abs(bestDelta),
  };
}

function smooth(values: number[], radius: number): number[] {
  const output: number[] = [];
  for (let i = 0; i < values.length; i += 1) {
    let sum = 0;
    let count = 0;
    for (let k = -radius; k <= radius; k += 1) {
      const value = values[i + k];
      if (value !== undefined) {
        sum += value;
        count += 1;
      }
    }
    output.push(count ? sum / count : 0);
  }
  return output;
}

/** 5th and 95th percentiles, from a subsample — robust to depth outliers. */
function robustRange(data: Float32Array): { low: number; high: number } {
  const stride = Math.max(1, Math.floor(data.length / 4096));
  const samples: number[] = [];
  for (let i = 0; i < data.length; i += stride) samples.push(data[i] ?? 0);
  samples.sort((a, b) => a - b);

  return {
    low: samples[Math.floor(samples.length * 0.05)] ?? 0,
    high: samples[Math.floor(samples.length * 0.95)] ?? 1,
  };
}
