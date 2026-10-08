import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveProvider } from './env.js';
import { buildEndpoint } from './provider.js';

const target = { project: 'p', location: 'global' };

test('vertex global endpoint has no region prefix', () => {
  assert.equal(
    buildEndpoint('vertex', 'm', target),
    'https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google/models/m:generateContent',
  );
});

test('vertex regional endpoint uses the regional host', () => {
  assert.equal(
    buildEndpoint('vertex', 'm', { project: 'p', location: 'asia-south1' }),
    'https://asia-south1-aiplatform.googleapis.com/v1/projects/p/locations/asia-south1/publishers/google/models/m:generateContent',
  );
});

test('aistudio endpoint ignores project and location', () => {
  assert.equal(
    buildEndpoint('aistudio', 'm', target),
    'https://generativelanguage.googleapis.com/v1beta/models/m:generateContent',
  );
});

test('model id is URL-encoded', () => {
  assert.match(
    buildEndpoint('vertex', 'a/b c', target),
    /models\/a%2Fb%20c:generateContent$/,
  );
});

test('explicit provider wins', () => {
  assert.equal(resolveProvider('aistudio', 'proj'), 'aistudio');
  assert.equal(resolveProvider('vertex', ''), 'vertex');
});

test('provider defaults to vertex when a project is set, else aistudio', () => {
  assert.equal(resolveProvider(undefined, 'proj'), 'vertex');
  assert.equal(resolveProvider('', ''), 'aistudio');
  assert.equal(resolveProvider('nonsense', 'proj'), 'vertex');
});
