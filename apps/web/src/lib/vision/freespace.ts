import type { PathGuidance, SpatialDetection, Zone } from '../../types';
import type { TerrainReport } from './terrain';

/**
 * Where is there room to walk?
 *
 * Two independent sources are fused here:
 *
 *  - OBJECTS, from the on-device detector. Precise and labelled, but blind to
 *    the 79-out-of-80 things that are not a COCO class — a wall, a pole, a
 *    hedge, a glass door.
 *  - DEPTH, when the terrain layer is running. Sees shape rather than
 *    category, so it catches the unnamed obstacles, but cannot name them.
 *
 * Neither alone is enough. Objects say *what*, depth says *whether*.
 *
 * Even fused, "clear" means "nothing detected in that lane" — not "safe to
 * walk". Surface-level judgement still comes from the cloud guide mode.
 */

/** Lane boundaries as fractions of frame width. Matches `zoneFor` in spatial.ts. */
const LEFT_EDGE = 0.35;
const RIGHT_EDGE = 0.65;

/** Distance reported when a lane has nothing in it at all. */
const MAX_CLEARANCE_M = 12;

/** Ahead-clearance below this counts as blocked. */
const BLOCKED_AHEAD_M = 3;

/** A sidestep is only worth suggesting if it buys this much extra room. */
const WORTHWHILE_GAIN_M = 1.5;

/** Ignore anything beyond this — it is not a path problem yet. */
const RELEVANT_RANGE_M = 10;

/** Depth openness below this counts as an obstructed lane. */
const DEPTH_BLOCKED_OPENNESS = 0.28;

/** Clearance assigned to a lane that depth says is blocked. */
const DEPTH_BLOCKED_CLEARANCE_M = 1.5;

export function analyzePath(
  detections: SpatialDetection[],
  frameWidth: number,
  frameHeight: number,
  terrain?: TerrainReport | null,
): PathGuidance {
  const clearance: Record<Zone, number> = {
    left: MAX_CLEARANCE_M,
    ahead: MAX_CLEARANCE_M,
    right: MAX_CLEARANCE_M,
  };

  if (frameWidth <= 0) {
    return {
      clearance,
      aheadBlocked: false,
      clearest: 'ahead',
      phrase: null,
      urgency: 0,
    };
  }

  for (const detection of detections) {
    const [x, y, w, h] = detection.bbox;

    // Only things standing on the ground near the user can block a footpath.
    // A sign high in the frame is not in the way.
    const baseRatio = frameHeight > 0 ? (y + h) / frameHeight : 1;
    if (baseRatio < 0.45) continue;

    const distance =
      detection.distanceM ??
      // Unknown real-world size: fall back to how much of the view it fills.
      (w * h) / (frameWidth * Math.max(1, frameHeight)) * 40;

    if (distance > RELEVANT_RANGE_M) continue;

    const startRatio = x / frameWidth;
    const endRatio = (x + w) / frameWidth;

    for (const zone of spannedZones(startRatio, endRatio)) {
      clearance[zone] = Math.min(clearance[zone], distance);
    }
  }

  // Depth can veto a lane the detector believed was empty. A brick wall is
  // not a COCO class, but it is still a wall.
  if (terrain) {
    for (const zone of ['left', 'ahead', 'right'] as Zone[]) {
      if (terrain.openness[zone] < DEPTH_BLOCKED_OPENNESS) {
        clearance[zone] = Math.min(clearance[zone], DEPTH_BLOCKED_CLEARANCE_M);
      }
    }
  }

  const aheadBlocked = clearance.ahead < BLOCKED_AHEAD_M;
  const clearest = (['ahead', 'left', 'right'] as Zone[]).reduce((best, zone) =>
    clearance[zone] > clearance[best] ? zone : best,
  );

  let phrase: string | null = null;
  let urgency = 0;

  if (aheadBlocked) {
    const gain = clearance[clearest] - clearance.ahead;
    if (clearest !== 'ahead' && gain >= WORTHWHILE_GAIN_M && clearance[clearest] >= 3) {
      phrase = `Keep a bit ${clearest}.`;
      urgency = 0.6;
    } else {
      phrase = 'Blocked ahead.';
      urgency = 0.75;
    }
  }

  return { clearance, aheadBlocked, clearest, phrase, urgency };
}

function spannedZones(startRatio: number, endRatio: number): Zone[] {
  const zones: Zone[] = [];
  if (startRatio < LEFT_EDGE) zones.push('left');
  if (endRatio > LEFT_EDGE && startRatio < RIGHT_EDGE) zones.push('ahead');
  if (endRatio > RIGHT_EDGE) zones.push('right');
  return zones;
}
