/**
 * Turning model boxes into words a blind person can act on.
 *
 * Vision models are good at *what* and poor at *where relative to me*: they
 * confuse the image's frame with the user's body and invent distances. So the
 * model only marks where a direction or proximity belongs, with `{dir:id}` and
 * `{near:id}`, and this file fills those in from the object's box. The words
 * are always the same small vocabulary, and never a number of metres.
 */

/** [ymin, xmin, ymax, xmax], normalised 0-1000, as Gemini returns them. */
export type Box = [number, number, number, number];

export type Direction =
  | 'on your left'
  | 'slightly to your left'
  | 'straight ahead'
  | 'slightly to your right'
  | 'on your right';

export type Proximity =
  | 'right in front of you'
  | 'within reach'
  | 'a few steps away'
  | 'further away';

export interface PlacedObject {
  id: string;
  box_2d: Box;
}

/**
 * Five sectors across the camera's horizontal field of view (~65° on phones),
 * so each is roughly 13° wide. The front camera sees a mirror image: what is
 * on the left of the picture is on the user's right.
 */
export function directionOf(box: Box, mirrored: boolean): Direction {
  const raw = (box[1] + box[3]) / 2 / 1000;
  const x = mirrored ? 1 - raw : raw;
  if (x < 0.2) return 'on your left';
  if (x < 0.4) return 'slightly to your left';
  if (x <= 0.6) return 'straight ahead';
  if (x <= 0.8) return 'slightly to your right';
  return 'on your right';
}

/**
 * Coarse proximity from how much of the view an object fills and how low its
 * base sits. A ground-standing object near the bottom edge is close to the
 * user's feet; one that fills a third of the frame is right in front of them.
 * Deliberately coarse: four honest bands beat a precise-sounding wrong number.
 */
export function proximityOf(box: Box): Proximity {
  const [ymin, xmin, ymax, xmax] = box;
  const area = (Math.max(0, xmax - xmin) * Math.max(0, ymax - ymin)) / 1e6;
  if (area >= 0.3) return 'right in front of you';
  if (area >= 0.12 || ymax >= 900) return 'within reach';
  if (area >= 0.025 || ymax >= 700) return 'a few steps away';
  return 'further away';
}

const PLACEHOLDER = /\{(dir|near):([A-Za-z0-9_-]+)\}/g;

export function fillPlaceholders(
  say: string,
  objects: PlacedObject[],
  mirrored: boolean,
): string {
  const byId = new Map(objects.map((o) => [o.id, o]));

  const filled = say.replace(PLACEHOLDER, (_match, kind: string, id: string) => {
    const object = byId.get(id);
    if (!object) return '';
    return kind === 'dir'
      ? directionOf(object.box_2d, mirrored)
      : proximityOf(object.box_2d);
  });

  return filled
    .replace(/\{[^{}]*\}/g, '')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/,(\s*[,.!?;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
