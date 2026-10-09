import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildScenePrompt, finaliseSay, NO_TEXT_SAY, parseSceneResponse, speechFor } from './scene.js';

test('read task with no legible text never describes the scene', () => {
  const parsed = parseSceneResponse(
    JSON.stringify({ say: 'You are on a busy street.', text: [], objects: [] }),
  );
  assert.equal(speechFor('read', parsed, false), NO_TEXT_SAY);
  const withText = parseSceneResponse(JSON.stringify({ say: 'Platform 3', text: ['Platform 3'] }));
  assert.equal(speechFor('read', withText, false), 'Platform 3');
});

test('parse: valid response is kept and normalised', () => {
  const raw = JSON.stringify({
    say: 'You are in an office. A person {dir:o1} is walking {near:o1}.',
    place: { environment: 'indoor', category: 'office', specific: 'open-plan desks', traffic: 'none' },
    path: { status: 'clear', surface: 'carpet', open_side: 'both' },
    objects: [
      { id: 'o1', label: 'person', box_2d: [300, 120, 900, 260], moving: true, heading: 'towards', hazard: false },
    ],
    text: [],
  });
  const result = parseSceneResponse(raw);
  assert.equal(result.facts.place.category, 'office');
  assert.equal(result.facts.objects.length, 1);
  assert.equal(result.facts.objects[0]?.heading, 'towards');
});

test('parse: malformed JSON gives a safe empty result', () => {
  const result = parseSceneResponse('not json {');
  assert.equal(result.say, '');
  assert.equal(result.facts.objects.length, 0);
  assert.equal(result.facts.path.status, 'unknown');
});

test('parse: unknown enums fall back, boxes are clamped and ordered, objects capped', () => {
  const objects = Array.from({ length: 15 }, (_, i) => ({
    id: `o${i}`,
    label: 'chair',
    box_2d: [1200, -5, 100, 50],
    moving: 'yes',
    heading: 'sideways',
    hazard: false,
  }));
  const result = parseSceneResponse(
    JSON.stringify({ say: 'x', place: { category: 'spaceship', traffic: 'jam' }, path: { status: 'meh' }, objects }),
  );
  assert.equal(result.facts.place.category, 'other');
  assert.equal(result.facts.place.traffic, 'none');
  assert.equal(result.facts.path.status, 'unknown');
  assert.equal(result.facts.objects.length, 8);
  const box = result.facts.objects[0]!.box_2d;
  assert.deepEqual(box, [100, 0, 1000, 50]);
  assert.equal(result.facts.objects[0]!.heading, 'unknown');
  assert.equal(result.facts.objects[0]!.moving, false);
});

test('finaliseSay fills placeholders, the open side, and strips markdown', () => {
  const parsed = parseSceneResponse(
    JSON.stringify({
      say: '**Corridor** ahead; a door {dir:d}. The way is open {open}.',
      path: { status: 'narrowing', open_side: 'left' },
      objects: [{ id: 'd', label: 'door', box_2d: [200, 850, 800, 980] }],
    }),
  );
  assert.equal(
    finaliseSay(parsed, false),
    'Corridor ahead; a door on your right. The way is open to your left.',
  );
  // Front camera mirrors both the object and the open side.
  assert.equal(
    finaliseSay(parsed, true),
    'Corridor ahead; a door on your left. The way is open to your right.',
  );
});

test('prompt: find task carries the query, update carries previous and events', () => {
  const find = buildScenePrompt({ task: 'find', query: 'my goggles' });
  assert.match(find.user, /my goggles/);
  const update = buildScenePrompt({
    task: 'update',
    previous: 'You are in an office.',
    localEvents: ['person passed on the left'],
    walking: true,
  });
  assert.match(update.user, /You are in an office\./);
  assert.match(update.user, /person passed on the left/);
  assert.match(update.user, /walking/);
});

test('prompt: every task forbids spoken direction words and numbers', () => {
  for (const task of ['orient', 'update', 'find', 'read', 'ask', 'verify_step'] as const) {
    const { system } = buildScenePrompt({ task, query: 'q' });
    assert.match(system, /\{dir:/);
    assert.match(system, /never.*(metres|meters|numbers)/i);
  }
});
