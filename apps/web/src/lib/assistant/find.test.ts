import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideFindTick, matchesTarget, notInViewGuidance } from './find.js';

test('not-in-view alternates left then right, names the target', () => {
  assert.equal(
    notInViewGuidance('goggles', 0),
    "I can't see your goggles yet. Move your camera slowly to the left.",
  );
  assert.equal(
    notInViewGuidance('goggles', 1),
    "I can't see your goggles yet. Move your camera slowly to the right.",
  );
});

test('found=false + detector agrees = move-camera prompt, never a guessed direction', () => {
  const d = decideFindTick({
    target: 'goggles', found: false, detectorSees: false,
    say: 'To your right, within reach.', turn: 0,
  });
  assert.equal(d.action, 'not-in-view');
  assert.match(d.text, /Move your camera slowly to the left/);
  assert.doesNotMatch(d.text, /To your right/);
});

test('found=true = speak the direction', () => {
  const d = decideFindTick({
    target: 'goggles', found: true, detectorSees: false,
    say: 'Your goggles are slightly to your right, within reach.', turn: 0,
  });
  assert.equal(d.action, 'found');
  assert.match(d.text, /slightly to your right/);
});

test('found=false but detector sees it = hold steady, no direction claim', () => {
  const d = decideFindTick({
    target: 'phone', found: false, detectorSees: true, say: '', turn: 0,
  });
  assert.equal(d.action, 'hold');
  assert.match(d.text, /Hold steady/);
});

test('no verdict + spoken line = speak it; no verdict + silence = scan prompt', () => {
  const a = decideFindTick({ target: 'keys', found: null, detectorSees: false, say: 'A little to your left.', turn: 0 });
  assert.equal(a.action, 'say');
  const b = decideFindTick({ target: 'keys', found: null, detectorSees: false, say: '', turn: 0 });
  assert.equal(b.action, 'scan');
});

test('matchesTarget is fuzzy: phone matches cell phone, goggles matches nothing usual', () => {
  assert.equal(matchesTarget(['cell phone', 'chair'], 'phone'), true);
  assert.equal(matchesTarget(['chair', 'person'], 'goggles'), false);
  assert.equal(matchesTarget([], 'phone'), false);
});
