import assert from 'node:assert/strict';
import { test } from 'node:test';

import { directionOf, fillPlaceholders, proximityOf } from './geometry.js';
import type { Box } from './geometry.js';

// [ymin, xmin, ymax, xmax], 0-1000
const at = (xCenter: number, w = 100, ymin = 400, ymax = 600): Box => [
  ymin,
  xCenter - w / 2,
  ymax,
  xCenter + w / 2,
];

test('direction sectors from box centre (back camera)', () => {
  assert.equal(directionOf(at(100), false), 'on your left');
  assert.equal(directionOf(at(300), false), 'slightly to your left');
  assert.equal(directionOf(at(500), false), 'straight ahead');
  assert.equal(directionOf(at(700), false), 'slightly to your right');
  assert.equal(directionOf(at(900), false), 'on your right');
});

test('front camera mirrors left and right', () => {
  assert.equal(directionOf(at(100), true), 'on your right');
  assert.equal(directionOf(at(900), true), 'on your left');
  assert.equal(directionOf(at(500), true), 'straight ahead');
});

test('proximity bands from apparent size and ground contact', () => {
  assert.equal(proximityOf([100, 100, 1000, 900]), 'right in front of you');
  assert.equal(proximityOf([500, 400, 950, 600]), 'within reach');
  assert.equal(proximityOf([450, 450, 750, 550]), 'a few steps away');
  assert.equal(proximityOf([400, 480, 480, 520]), 'further away');
});

const objects = [
  { id: 'd1', box_2d: at(100) },
  { id: 'p2', box_2d: [450, 450, 750, 550] as Box },
];

test('fills direction and proximity placeholders', () => {
  assert.equal(
    fillPlaceholders('A door {dir:d1}. A person {dir:p2}, {near:p2}.', objects, false),
    'A door on your left. A person straight ahead, a few steps away.',
  );
});

test('unknown ids are removed without leaving braces or stray commas', () => {
  const out = fillPlaceholders('A chair {dir:zz}, {near:zz}. Path is clear.', objects, false);
  assert.equal(out, 'A chair. Path is clear.');
  assert.doesNotMatch(out, /[{}]/);
});

test('stray malformed braces are stripped', () => {
  assert.equal(fillPlaceholders('A table {dir:}{near} ahead.', objects, false), 'A table ahead.');
});
