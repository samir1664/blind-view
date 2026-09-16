/**
 * Offline simulation of a walk, used to sanity-check the tracking, path and
 * director logic without needing to physically walk in front of a camera.
 *
 * Run with:  npx tsx apps/web/scripts/simulate-guide.ts
 */

import { analyzePath } from '../src/lib/vision/freespace';
import { toSpatial } from '../src/lib/vision/spatial';
import { analyzeTerrain } from '../src/lib/vision/terrain';
import { ObjectTracker } from '../src/lib/vision/tracking';
import { NarrationDirector } from '../src/lib/narration/director';
import type { Detection } from '../src/types';

const FRAME_W = 1280;
const FRAME_H = 720;
const FPS_MS = 125;

const FOCAL_PX = FRAME_H / 2 / Math.tan((55 / 2) * (Math.PI / 180));
const REAL_H: Record<string, number> = { dog: 0.55, person: 1.7, car: 1.5 };

/** Build a bounding box for an object at a given distance and screen position. */
function box(label: string, distanceM: number, cxRatio: number): Detection {
  const h = (REAL_H[label]! * FOCAL_PX) / distanceM;
  const w = h * 0.8;
  const cx = cxRatio * FRAME_W;
  // Base sits low in the frame, as a ground-standing object does.
  const y = FRAME_H * 0.75 - h;
  return { label, score: 0.8, bbox: [cx - w / 2, y, w, h] };
}

const tracker = new ObjectTracker({ sensitivity: 'medium', cooldownMs: 5000 });
const director = new NarrationDirector({ minGapMs: 1600 });

let now = 1_000_000;

console.log('── Scenario 1: park walk, dog approaching, person passing, car crossing');

for (let frame = 0; frame < 32; frame += 1) {
  const t = (frame * FPS_MS) / 1000;
  const detections: Detection[] = [];

  // A dog trotting towards the user: 8 m closing at 1.6 m/s, slightly left.
  const dogDistance = 8 - 1.6 * t;
  if (dogDistance > 0.6) detections.push(box('dog', dogDistance, 0.42));

  // A person walking across the view from centre to the right edge.
  const personCx = 0.55 + 0.28 * t;
  if (personCx < 1.05) detections.push(box('person', 5, Math.min(personCx, 0.98)));

  // A car crossing at speed, entering after 1.5 s.
  if (t > 1.5) {
    const carDistance = 22 - 7 * (t - 1.5);
    if (carDistance > 1) detections.push(box('car', carDistance, 0.8));
  }

  const spatial = detections.map((d) => toSpatial(d, FRAME_W, FRAME_H));
  const { events } = tracker.update(spatial, FRAME_W, now);
  const guidance = analyzePath(spatial, FRAME_W, FRAME_H);
  const spoken = director.submit(events, guidance, null, now);

  for (const utterance of spoken) {
    console.log(
      `t=${t.toFixed(2)}s  [p${utterance.priority} ${utterance.source}]  ${utterance.text}`,
    );
  }

  now += FPS_MS;
}

console.log('\n── Scenario 2: bench parked in the path ahead, left side clear');

const tracker2 = new ObjectTracker({ sensitivity: 'medium', cooldownMs: 5000 });
const director2 = new NarrationDirector({ minGapMs: 1600 });
now += 60_000;

for (let frame = 0; frame < 24; frame += 1) {
  const t = (frame * FPS_MS) / 1000;

  // A bench sitting still, directly ahead, that the user is walking up to.
  const detections = [box2('bench', Math.max(1.2, 6 - 1.2 * t), 0.5)];

  const spatial = detections.map((d) => toSpatial(d, FRAME_W, FRAME_H));
  const { events } = tracker2.update(spatial, FRAME_W, now);
  const guidance = analyzePath(spatial, FRAME_W, FRAME_H);
  const spoken = director2.submit(events, guidance, null, now);

  for (const utterance of spoken) {
    console.log(
      `t=${t.toFixed(2)}s  [p${utterance.priority} ${utterance.source}]  ${utterance.text}` +
        `   (clear: L${guidance.clearance.left.toFixed(1)} A${guidance.clearance.ahead.toFixed(1)} R${guidance.clearance.right.toFixed(1)})`,
    );
  }

  now += FPS_MS;
}

/** Same as `box` but for classes outside the small REAL_H table above. */
function box2(label: string, distanceM: number, cxRatio: number): Detection {
  const h = (0.9 * FOCAL_PX) / distanceM;
  const w = h * 1.6;
  const cx = cxRatio * FRAME_W;
  const y = FRAME_H * 0.78 - h;
  return { label, score: 0.8, bbox: [cx - w / 2, y, w, h] };
}

// ── Terrain ────────────────────────────────────────────────────────────────
// Synthetic depth maps. Depth Anything predicts inverse depth: LARGER means
// NEARER. The floor is nearest at the bottom of the frame (at the user's feet)
// and recedes as you move up the image.

console.log('\n── Scenario 3: terrain from synthetic depth maps');

const N = 196;

function makeDepth(
  fn: (xRatio: number, yRatio: number) => number,
): { data: Float32Array; size: number } {
  const data = new Float32Array(N * N);
  for (let y = 0; y < N; y += 1) {
    for (let x = 0; x < N; x += 1) {
      data[y * N + x] = fn(x / N, y / N);
    }
  }
  return { data, size: N };
}

/** Flat ground: nearness grows steadily toward the bottom of the frame. */
const flat = makeDepth((_x, y) => 0.2 + y * 1.6);

/** A kerb: everything beyond the edge sits noticeably further away. */
const dropOff = makeDepth((_x, y) => (y < 0.78 ? 0.2 + y * 1.6 - 0.9 : 0.2 + y * 1.6));

/** A step up: the surface beyond the edge rises toward the user. */
const stepUp = makeDepth((_x, y) => (y < 0.78 ? 0.2 + y * 1.6 + 0.9 : 0.2 + y * 1.6));

/** Flat ground with a wall filling the left third. */
const wallLeft = makeDepth((x, y) => (x < 0.3 ? 2.6 : 0.2 + y * 1.6));

for (const [name, map] of [
  ['flat ground        ', flat],
  ['kerb / drop ahead  ', dropOff],
  ['step up ahead      ', stepUp],
  ['wall on the left   ', wallLeft],
] as const) {
  const report = analyzeTerrain(map);
  if (!report) {
    console.log(`${name} -> no reading`);
    continue;
  }
  const o = report.openness;
  console.log(
    `${name} -> step=${report.step ? report.step.kind : 'none'}` +
      `  openness L${o.left.toFixed(2)} A${o.ahead.toFixed(2)} R${o.right.toFixed(2)}` +
      `  clearest=${report.clearest}` +
      `  say: ${report.phrase ?? '(nothing)'}`,
  );
}
