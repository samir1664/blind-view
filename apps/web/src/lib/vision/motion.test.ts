import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StillnessGate } from './motion.js';

test('moving stays in moving', () => {
  const g = new StillnessGate(6000);
  assert.equal(g.update(true, 1000), 'moving');
  assert.equal(g.update(true, 2000), 'moving');
});

test('still for 6s prompts exactly once, then waits', () => {
  const g = new StillnessGate(6000);
  g.update(true, 0); // moving at t=0
  assert.equal(g.update(false, 5000), 'moving'); // still, inside grace period
  assert.equal(g.update(false, 6000), 'prompt'); // 6s still -> ask once
  assert.equal(g.update(false, 9000), 'waiting'); // no second prompt
  assert.equal(g.update(false, 20000), 'waiting');
});

test('movement after waiting resumes, then moving again', () => {
  const g = new StillnessGate(6000);
  g.update(true, 0);
  assert.equal(g.update(false, 6000), 'prompt');
  assert.equal(g.update(false, 7000), 'waiting');
  assert.equal(g.update(true, 8000), 'resumed');
  assert.equal(g.update(true, 9000), 'moving');
});

test('reset restarts the still clock', () => {
  const g = new StillnessGate(6000);
  g.update(true, 0);
  assert.equal(g.update(false, 6000), 'prompt');
  g.reset(7000);
  assert.equal(g.update(false, 12000), 'moving'); // only 5s since reset
  assert.equal(g.update(false, 13000), 'prompt');
});
