import type { Proximity, Zone } from '../../types';

/**
 * Shared vocabulary for deciding what matters and how to say it.
 *
 * `tracking.ts` supplies the *motion*; this file supplies the *judgement* —
 * how dangerous each class is, and what to call it out loud.
 */

/** How dangerous a class is, independent of distance. 0…1. */
export const SEVERITY: Record<string, number> = {
  car: 1,
  truck: 1,
  bus: 1,
  train: 1,
  motorcycle: 0.95,
  bicycle: 0.85,
  horse: 0.7,
  cow: 0.7,
  person: 0.5,
  dog: 0.5,
  bear: 1,
  // Static things you can walk into. Only matter when they are right there.
  'fire hydrant': 0.4,
  'parking meter': 0.4,
  'stop sign': 0.35,
  'traffic light': 0.35,
  bench: 0.4,
  chair: 0.4,
  couch: 0.35,
  'potted plant': 0.35,
  'dining table': 0.4,
  bed: 0.3,
  toilet: 0.3,
  refrigerator: 0.35,
  suitcase: 0.35,
  backpack: 0.25,
  umbrella: 0.25,
};

export const DEFAULT_SEVERITY = 0.15;

export function severityOf(label: string): number {
  return SEVERITY[label] ?? DEFAULT_SEVERITY;
}

/** Classes that move under their own power, and so can approach the user. */
export const MOBILE_CLASSES = new Set([
  'car',
  'truck',
  'bus',
  'train',
  'motorcycle',
  'bicycle',
  'person',
  'dog',
  'cat',
  'horse',
  'cow',
  'bear',
  'sheep',
]);

export const PROXIMITY_WEIGHT: Record<Proximity, number> = {
  'very close': 1,
  close: 0.75,
  near: 0.4,
  far: 0.1,
};

export const PROXIMITY_RANK: Record<Proximity, number> = {
  far: 0,
  near: 1,
  close: 2,
  'very close': 3,
};

/** Friendlier spoken names for a few awkward COCO labels. */
const SPOKEN_LABEL: Record<string, string> = {
  'potted plant': 'plant',
  'dining table': 'table',
  'cell phone': 'phone',
  'sports ball': 'ball',
  tv: 'screen',
};

export function spokenLabel(label: string): string {
  return SPOKEN_LABEL[label] ?? label;
}

export type Sensitivity = 'low' | 'medium' | 'high';

export const URGENCY_THRESHOLD: Record<Sensitivity, number> = {
  low: 0.55,
  medium: 0.32,
  high: 0.18,
};

/** "on your left" / "ahead" / "on your right". */
export function whereWord(zone: Zone): string {
  if (zone === 'ahead') return 'ahead';
  return zone === 'left' ? 'on your left' : 'on your right';
}

/** " from your left" / "" / " from your right" — for approach phrasing. */
export function fromWord(zone: Zone): string {
  if (zone === 'ahead') return '';
  return zone === 'left' ? ' from your left' : ' from your right';
}

export function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
