/** Shared domain types for Blind View. */

/** Horizontal position relative to the user's facing direction. */
export type Zone = 'left' | 'ahead' | 'right';

/** How urgently something needs to be avoided. */
export type Proximity = 'very close' | 'close' | 'near' | 'far';

export type Verbosity = 'brief' | 'normal' | 'detailed';

export type NarrationMode =
  | 'scene'
  | 'guide'
  | 'text'
  | 'find'
  | 'currency'
  | 'ask';

/** Raw output of the on-device detector. */
export interface Detection {
  label: string;
  score: number;
  /** [x, y, width, height] in source-video pixels. */
  bbox: [number, number, number, number];
}

/** A detection enriched with where it is and how far away. */
export interface SpatialDetection extends Detection {
  zone: Zone;
  /** Rough metres, from apparent size. Null when the class has no known size. */
  distanceM: number | null;
  proximity: Proximity;
  /** -1 (hard left) … 0 (centre) … 1 (hard right), for audio panning. */
  pan: number;
  /** Stable identity for deduplication: `label|zone`. */
  key: string;
}

/** Something worth interrupting the user for. */
export interface HazardAlert {
  key: string;
  label: string;
  zone: Zone;
  proximity: Proximity;
  distanceM: number | null;
  pan: number;
  /** Higher means more urgent. */
  urgency: number;
  spoken: string;
}

/** A detection matched to the same physical object across frames. */
export interface TrackedDetection extends SpatialDetection {
  /** Stable per-object identity for as long as it stays in view. */
  id: number;
  /** Metres per second, positive when closing on the user. */
  approachRate: number | null;
  /** Normalised frame-widths per second, positive when moving right. */
  lateralRate: number | null;
  /** Seconds until contact at the current closing speed. */
  timeToContactSec: number | null;
  /** Consecutive frames this object has been matched. */
  hits: number;
}

/**
 * What a tracked object is *doing* — the difference between "a dog" and
 * "a dog coming towards you".
 */
export type SceneEventKind =
  | 'imminent'
  | 'approaching'
  | 'passing'
  | 'blocking'
  | 'appeared';

export interface SceneEvent {
  kind: SceneEventKind;
  trackId: number;
  label: string;
  zone: Zone;
  pan: number;
  distanceM: number | null;
  timeToContactSec: number | null;
  /** 0…1. Drives both ordering and whether speech is interrupted. */
  urgency: number;
  phrase: string;
}

/** Where the walkable route is. */
export interface PathGuidance {
  /** Metres of clear space in each lane. */
  clearance: Record<Zone, number>;
  aheadBlocked: boolean;
  /** The lane with the most room. */
  clearest: Zone;
  /** Spoken steer, or null when the way ahead is fine and needs no comment. */
  phrase: string | null;
  urgency: number;
}

export type TranscriptSource =
  | 'hazard'
  | 'guide'
  | 'place'
  | 'scene'
  | 'text'
  | 'find'
  | 'currency'
  | 'ask'
  | 'system';

export interface TranscriptEntry {
  id: string;
  at: number;
  source: TranscriptSource;
  text: string;
}

export type EngineStatus =
  | 'idle'
  | 'requesting-camera'
  | 'loading-model'
  | 'running'
  | 'error';

/** Broad setting, from the place classifier. */
export type Environment = 'indoor' | 'outdoor';

/**
 * Fixed place taxonomy. Bounded on purpose: each category maps to a narration
 * playbook on the server, so free-form categories would silently fall back to
 * generic descriptions.
 */
export const PLACE_CATEGORIES = [
  'home',
  'office',
  'mall',
  'shop',
  'restaurant',
  'hospital',
  'school',
  'station',
  'gym',
  'road',
  'park',
  'market',
  'parking',
  'sidewalk',
  'other',
] as const;

export type PlaceCategory = (typeof PLACE_CATEGORIES)[number];

/** Where the user is, from broad environment down to the specific spot. */
export interface PlaceContext {
  environment: Environment;
  category: PlaceCategory;
  /** e.g. "kitchen", "escalator landing", "zebra crossing". */
  place: string;
  confidence: number;
  /** Short spoken line, used when the place changes. */
  announcement: string;
  /** Place-specific things visible right now. */
  watchFor: string[];
  /** "outdoor > road > zebra crossing". */
  path: string;
}
