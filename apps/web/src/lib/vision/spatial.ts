import type { Detection, Proximity, SpatialDetection, Zone } from '../../types';

/**
 * Turning a 2-D bounding box into "how far away is that, and which side".
 *
 * We deliberately do NOT run a depth network here. A monocular depth model
 * costs another 30–80 ms per frame and drains the battery, and for the thing
 * we actually care about — "is that car close enough to matter" — the pinhole
 * approximation below is accurate enough. It works because most hazards are
 * objects whose real-world height is roughly known and roughly constant.
 *
 *     distance ≈ realHeight × focalLengthPx / apparentHeightPx
 *
 * Treat every number that comes out of this file as an estimate, and phrase it
 * to the user as one ("about three metres", never "3.2 metres").
 */

/** Typical real-world height in metres, by COCO class. */
const REAL_HEIGHT_M: Record<string, number> = {
  person: 1.7,
  bicycle: 1.1,
  car: 1.5,
  motorcycle: 1.3,
  bus: 3.2,
  truck: 3.2,
  train: 3.8,
  boat: 2.0,
  'traffic light': 0.9,
  'fire hydrant': 0.75,
  'stop sign': 0.75,
  'parking meter': 1.3,
  bench: 0.9,
  dog: 0.55,
  cat: 0.3,
  horse: 1.6,
  chair: 0.95,
  couch: 0.85,
  'potted plant': 0.6,
  bed: 0.6,
  'dining table': 0.75,
  toilet: 0.75,
  tv: 0.6,
  laptop: 0.25,
  refrigerator: 1.7,
  oven: 0.9,
  microwave: 0.3,
  sink: 0.25,
  backpack: 0.5,
  umbrella: 0.9,
  suitcase: 0.6,
  bottle: 0.25,
  cup: 0.12,
  book: 0.24,
  clock: 0.3,
  'cell phone': 0.15,
};

/**
 * Vertical field of view of a typical phone rear camera, in degrees.
 * Only affects absolute scale; the relative ordering of "closer / further"
 * stays correct even if this is off by ten degrees.
 */
const VFOV_DEG = 55;

const DEG_TO_RAD = Math.PI / 180;

export function estimateDistanceM(
  label: string,
  bbox: [number, number, number, number],
  frameHeight: number,
): number | null {
  const realHeight = REAL_HEIGHT_M[label];
  if (realHeight === undefined || frameHeight <= 0) return null;

  const [, y, , h] = bbox;
  if (h <= 1) return null;

  const focalPx = frameHeight / 2 / Math.tan((VFOV_DEG / 2) * DEG_TO_RAD);
  let distance = (realHeight * focalPx) / h;

  // If the box runs off both the top and bottom of the frame, the object is
  // larger than our view of it, so the height-based estimate is far too big.
  // Anything filling the frame like that is, practically speaking, right here.
  const clippedTop = y <= 2;
  const clippedBottom = y + h >= frameHeight - 2;
  if (clippedTop && clippedBottom) distance = Math.min(distance, 1.2);

  return Math.max(0.3, Math.min(60, distance));
}

export function zoneFor(centerXRatio: number): Zone {
  if (centerXRatio < 0.35) return 'left';
  if (centerXRatio > 0.65) return 'right';
  return 'ahead';
}

export function panFor(centerXRatio: number): number {
  // Slightly compressed so centre-ish objects do not sound hard-panned.
  return Math.max(-1, Math.min(1, (centerXRatio - 0.5) * 1.7));
}

export function proximityFor(
  distanceM: number | null,
  areaFraction: number,
): Proximity {
  if (distanceM === null) {
    // Unknown real size: fall back to how much of the view it occupies.
    if (areaFraction > 0.3) return 'very close';
    if (areaFraction > 0.12) return 'close';
    if (areaFraction > 0.04) return 'near';
    return 'far';
  }
  if (distanceM < 1.5) return 'very close';
  if (distanceM < 3.5) return 'close';
  if (distanceM < 7) return 'near';
  return 'far';
}

export function toSpatial(
  detection: Detection,
  frameWidth: number,
  frameHeight: number,
  /** True when the video is mirrored on screen (front camera). */
  mirrored = false,
): SpatialDetection {
  const [x, y, w, h] = detection.bbox;

  let centerXRatio = frameWidth > 0 ? (x + w / 2) / frameWidth : 0.5;
  if (mirrored) centerXRatio = 1 - centerXRatio;
  centerXRatio = Math.max(0, Math.min(1, centerXRatio));

  const distanceM = estimateDistanceM(detection.label, [x, y, w, h], frameHeight);
  const areaFraction =
    frameWidth > 0 && frameHeight > 0 ? (w * h) / (frameWidth * frameHeight) : 0;

  const zone = zoneFor(centerXRatio);

  return {
    ...detection,
    zone,
    distanceM,
    proximity: proximityFor(distanceM, areaFraction),
    pan: panFor(centerXRatio),
    key: `${detection.label}|${zone}`,
  };
}

/** Human phrasing for a distance, or null when we genuinely do not know. */
export function describeDistance(distanceM: number | null): string | null {
  if (distanceM === null) return null;
  if (distanceM < 1) return 'right in front of you';
  if (distanceM < 2) return 'about two steps away';
  if (distanceM < 4) return 'about three metres';
  if (distanceM < 8) return 'about six metres';
  return 'further away';
}
