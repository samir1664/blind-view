import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDuplicate, nextIdleLine, pickUpdate, shouldSkipTick } from './narration.js';

test('duplicate ignores case/punctuation', () => {
  assert.equal(isDuplicate('Way ahead is clear.', 'way ahead is clear'), true);
  assert.equal(isDuplicate('Way ahead is clear.', 'Person ahead.'), false);
});
test('skip while speaking or user talking', () => {
  assert.equal(shouldSkipTick({ speaking: true, userTalking: false }), true);
  assert.equal(shouldSkipTick({ speaking: false, userTalking: true }), true);
  assert.equal(shouldSkipTick({ speaking: false, userTalking: false }), false);
});
test('idle line rotates, never repeats last', () => {
  const line = nextIdleLine('Way ahead is clear.');
  assert.notEqual(line, 'Way ahead is clear.');
});
test('pickUpdate prefers fresh scene, else idle every other tick', () => {
  assert.equal(pickUpdate({ sceneSay: 'Person passing left.', lastSay: '', tickCount: 1, changed: true }), 'Person passing left.');
  assert.equal(pickUpdate({ sceneSay: 'Person passing left.', lastSay: 'Person passing left.', tickCount: 2, changed: false }), null);
  const idle = pickUpdate({ sceneSay: '', lastSay: 'x', tickCount: 1, changed: false });
  assert.ok(idle && idle.length > 0);
});
