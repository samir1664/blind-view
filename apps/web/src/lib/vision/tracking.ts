import {
  capitalize,
  fromWord,
  MOBILE_CLASSES,
  PROXIMITY_WEIGHT,
  severityOf,
  spokenLabel,
  URGENCY_THRESHOLD,
  whereWord,
} from './hazards';
import type { Sensitivity } from './hazards';
import type {
  SceneEvent,
  SceneEventKind,
  SpatialDetection,
  TrackedDetection,
} from '../../types';

export type { Sensitivity };

/**
 * Multi-frame object tracking.
 *
 * This is the piece that turns "a dog" into "a dog coming towards you". A
 * single frame can only ever tell you what exists; intent and danger live in
 * how things change between frames. We associate detections across frames into
 * tracks, differentiate distance over time to get closing speed, and derive
 * time-to-contact — which is what actually justifies saying "stop".
 *
 * Association is IoU + centre proximity rather than a learned re-ID model:
 * at 8 fps with a handful of objects, the simple approach is accurate and
 * costs microseconds.
 */

/** Minimum match score to consider a detection the same object as a track. */
const MATCH_THRESHOLD = 0.2;

/** Drop a track after this many consecutive frames without a match. */
const MAX_MISSES = 6;

/** Window of history used to differentiate position. */
const HISTORY_MS = 1400;

/** Rates computed over a shorter span than this are too noisy to trust. */
const MIN_RATE_WINDOW_SEC = 0.25;

/** Closing speeds below this are indistinguishable from estimator jitter. */
const MIN_CLOSING_SPEED = 0.2;

/** Per-event-kind minimum gap, in milliseconds. */
const EVENT_COOLDOWN: Record<SceneEventKind, number> = {
  imminent: 1500,
  approaching: 3500,
  passing: 4000,
  blocking: 5000,
  appeared: 6000,
};

/** Most severe first — only one event is emitted per object per frame. */
const KIND_ORDER: SceneEventKind[] = [
  'imminent',
  'approaching',
  'passing',
  'blocking',
  'appeared',
];

interface Sample {
  t: number;
  /** Estimated distance in metres, or null for unknown-size classes. */
  d: number | null;
  /** Centre x as a 0…1 fraction of frame width. */
  cx: number;
}

interface Track {
  id: number;
  label: string;
  hits: number;
  misses: number;
  samples: Sample[];
  latest: SpatialDetection;
  announcedAt: Partial<Record<SceneEventKind, number>>;
}

export interface TrackerOptions {
  sensitivity: Sensitivity;
  /** Minimum gap before repeating the same kind of call-out. */
  cooldownMs: number;
}

export interface TrackerResult {
  tracked: TrackedDetection[];
  events: SceneEvent[];
}

export class ObjectTracker {
  private tracks: Track[] = [];
  private nextId = 1;
  private walking = false;
  private walkingSpeed = 1.2;

  constructor(private options: TrackerOptions) {}

  /** Ego-motion state from MotionTracker. While walking, static objects close at walking speed. */
  setWalking(walking: boolean, speedMps = 1.2): void {
    this.walking = walking;
    this.walkingSpeed = speedMps;
  }

  setOptions(options: Partial<TrackerOptions>): void {
    this.options = { ...this.options, ...options };
  }

  reset(): void {
    this.tracks = [];
    this.nextId = 1;
  }

  update(
    detections: SpatialDetection[],
    frameWidth: number,
    now: number,
  ): TrackerResult {
    this.associate(detections, frameWidth, now);

    const tracked: TrackedDetection[] = [];
    const events: SceneEvent[] = [];
    const threshold = URGENCY_THRESHOLD[this.options.sensitivity];

    for (const track of this.tracks) {
      if (track.misses > 0) continue; // not seen this frame

      const motion = this.rates(track, now);
      const item: TrackedDetection = {
        ...track.latest,
        id: track.id,
        hits: track.hits,
        approachRate: motion.approachRate,
        lateralRate: motion.lateralRate,
        timeToContactSec: motion.timeToContactSec,
      };
      tracked.push(item);

      const event = this.classify(track, item, now, threshold);
      if (event) events.push(event);
    }

    return {
      tracked,
      events: events.sort((a, b) => b.urgency - a.urgency),
    };
  }

  // ── Association ───────────────────────────────────────────
  private associate(
    detections: SpatialDetection[],
    frameWidth: number,
    now: number,
  ): void {
    for (const track of this.tracks) track.misses += 1;

    const pairs: Array<{ track: Track; detection: SpatialDetection; score: number }> =
      [];

    for (const track of this.tracks) {
      for (const detection of detections) {
        if (detection.label !== track.label) continue;
        const score = matchScore(track.latest.bbox, detection.bbox);
        if (score >= MATCH_THRESHOLD) pairs.push({ track, detection, score });
      }
    }

    pairs.sort((a, b) => b.score - a.score);

    const usedTracks = new Set<number>();
    const usedDetections = new Set<SpatialDetection>();

    for (const pair of pairs) {
      if (usedTracks.has(pair.track.id) || usedDetections.has(pair.detection)) {
        continue;
      }
      usedTracks.add(pair.track.id);
      usedDetections.add(pair.detection);

      pair.track.misses = 0;
      pair.track.hits += 1;
      pair.track.latest = pair.detection;
      pair.track.samples.push({
        t: now,
        d: pair.detection.distanceM,
        cx: centerX(pair.detection.bbox, frameWidth),
      });
      pair.track.samples = pair.track.samples.filter(
        (sample) => now - sample.t <= HISTORY_MS,
      );
    }

    for (const detection of detections) {
      if (usedDetections.has(detection)) continue;
      this.tracks.push({
        id: this.nextId++,
        label: detection.label,
        hits: 1,
        misses: 0,
        latest: detection,
        samples: [
          { t: now, d: detection.distanceM, cx: centerX(detection.bbox, frameWidth) },
        ],
        announcedAt: {},
      });
    }

    this.tracks = this.tracks.filter((track) => track.misses <= MAX_MISSES);
  }

  // ── Motion ────────────────────────────────────────────────
  private rates(
    track: Track,
    now: number,
  ): Pick<
    TrackedDetection,
    'approachRate' | 'lateralRate' | 'timeToContactSec'
  > {
    const samples = track.samples.filter((s) => now - s.t <= HISTORY_MS);
    const none = {
      approachRate: null,
      lateralRate: null,
      timeToContactSec: null,
    };
    if (samples.length < 3) return none;

    const first = samples[0];
    const last = samples[samples.length - 1];
    if (!first || !last) return none;

    const dt = (last.t - first.t) / 1000;
    if (dt < MIN_RATE_WINDOW_SEC) return none;

    // Bounding boxes jitter frame to frame, and distance is derived from box
    // height, so raw endpoint differences are badly noisy. Median-filter the
    // ends of the window before differentiating.
    const half = Math.max(1, Math.floor(samples.length / 3));
    const startD = median(samples.slice(0, half).map((s) => s.d));
    const endD = median(samples.slice(-half).map((s) => s.d));
    const startX = median(samples.slice(0, half).map((s) => s.cx));
    const endX = median(samples.slice(-half).map((s) => s.cx));

    const approachRate =
      startD !== null && endD !== null ? (startD - endD) / dt : null;
    const lateralRate =
      startX !== null && endX !== null ? (endX - startX) / dt : null;

    const distance = track.latest.distanceM;
    const timeToContactSec =
      approachRate !== null &&
      approachRate > MIN_CLOSING_SPEED &&
      distance !== null
        ? distance / approachRate
        : null;

    return { approachRate, lateralRate, timeToContactSec };
  }

  // ── Event classification ──────────────────────────────────
  private classify(
    track: Track,
    item: TrackedDetection,
    now: number,
    threshold: number,
  ): SceneEvent | null {
    const severity = severityOf(item.label);
    const label = spokenLabel(item.label);
    const distance = item.distanceM;
    const approach = item.approachRate;
    const ttc = item.timeToContactSec;
    const isMobile = MOBILE_CLASSES.has(item.label);

    const candidates: Array<{ kind: SceneEventKind; urgency: number; phrase: string }> =
      [];

    // Confirmed over several frames before we trust any motion claim.
    if (item.hits >= 3) {
      // Something fast will reach the user very soon. This is the only case
      // that earns the word "stop".
      if (
        ttc !== null &&
        ((severity >= 0.8 && ttc <= 2.5) || (ttc <= 1.2 && severity >= 0.4))
      ) {
        candidates.push({
          kind: 'imminent',
          urgency: 1,
          phrase: `Stop. ${capitalize(label)} ${whereWord(item.zone)}.`,
        });
      }

      // Ego-motion gate (F3): while walking, static people/cars close at walking speed.
      // Only call it "coming towards" if closing clearly faster than walking, or moving sideways.
      const approachThreshold = this.walking ? this.walkingSpeed + 0.6 : 0.45;
      if (isMobile && approach !== null && approach >= approachThreshold && (distance ?? 99) <= 9) {
        candidates.push({
          kind: 'approaching',
          urgency: 0.45 + 0.4 * severity,
          phrase: `${capitalize(label)} coming towards you${fromWord(item.zone)}.`,
        });
      }

      if (
        isMobile &&
        item.lateralRate !== null &&
        Math.abs(item.lateralRate) >= 0.22 &&
        (distance ?? 99) <= 7 &&
        (approach ?? 0) < 0.35
      ) {
        const where =
          item.zone === 'ahead'
            ? 'in front of you'
            : `on your ${item.zone === 'left' ? 'left' : 'right'}`;
        candidates.push({
          kind: 'passing',
          urgency: 0.2 + 0.3 * severity,
          phrase: `${capitalize(label)} passing ${where}.`,
        });
      }

      if (
        item.zone === 'ahead' &&
        (approach === null || Math.abs(approach) < 0.25) &&
        (distance ?? 99) <= 2.5
      ) {
        candidates.push({
          kind: 'blocking',
          urgency: 0.5,
          phrase: `${capitalize(label)} ahead, blocking your path.`,
        });
      }
    }

    // Fallback for anything simply present and near enough to matter.
    if (item.hits >= 2 && item.proximity !== 'far' && item.proximity !== 'near') {
      candidates.push({
        kind: 'appeared',
        urgency: severity * PROXIMITY_WEIGHT[item.proximity],
        phrase: `${capitalize(label)}, ${item.proximity}, ${whereWord(item.zone)}.`,
      });
    }

    for (const kind of KIND_ORDER) {
      const candidate = candidates.find((c) => c.kind === kind);
      if (!candidate) continue;
      if (candidate.urgency < threshold) continue;

      // "Dog, close, ahead" adds nothing right after "Dog coming towards you".
      // The plain presence call-out is a fallback for objects we have said
      // nothing else about, so hold it back until the track has gone quiet.
      if (kind === 'appeared') {
        const lastAnything = Math.max(
          0,
          ...Object.values(track.announcedAt).filter(
            (at): at is number => typeof at === 'number',
          ),
        );
        if (now - lastAnything < EVENT_COOLDOWN.appeared) continue;
      }

      const cooldown = Math.min(
        EVENT_COOLDOWN[kind],
        // The user's repeat-gap preference should never make a "stop" late.
        kind === 'imminent' ? EVENT_COOLDOWN.imminent : this.options.cooldownMs,
      );
      const last = track.announcedAt[kind] ?? 0;
      if (now - last < cooldown) continue;

      track.announcedAt[kind] = now;
      return {
        kind,
        trackId: item.id,
        label: item.label,
        zone: item.zone,
        pan: item.pan,
        distanceM: distance,
        timeToContactSec: ttc,
        urgency: candidate.urgency,
        phrase: candidate.phrase,
      };
    }

    return null;
  }
}

// ── Geometry helpers ────────────────────────────────────────

type Box = [number, number, number, number];

function centerX(bbox: Box, frameWidth: number): number {
  return frameWidth > 0 ? (bbox[0] + bbox[2] / 2) / frameWidth : 0.5;
}

function iou(a: Box, b: Box): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y2 = Math.min(a[1] + a[3], b[1] + b[3]);

  const overlap = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (overlap <= 0) return 0;

  const union = a[2] * a[3] + b[2] * b[3] - overlap;
  return union > 0 ? overlap / union : 0;
}

/**
 * IoU alone loses fast-moving objects whose boxes stop overlapping between
 * frames, so blend in how close the centres are relative to object size.
 */
function matchScore(a: Box, b: Box): number {
  const acx = a[0] + a[2] / 2;
  const acy = a[1] + a[3] / 2;
  const bcx = b[0] + b[2] / 2;
  const bcy = b[1] + b[3] / 2;

  const scale = Math.max(1, (a[2] + a[3] + b[2] + b[3]) / 4);
  const distance = Math.hypot(acx - bcx, acy - bcy) / scale;
  const closeness = Math.max(0, 1 - distance);

  return 0.7 * iou(a, b) + 0.3 * closeness;
}

function median(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (present.length === 0) return null;
  const mid = Math.floor(present.length / 2);
  if (present.length % 2 === 1) return present[mid] ?? null;
  return ((present[mid - 1] ?? 0) + (present[mid] ?? 0)) / 2;
}
