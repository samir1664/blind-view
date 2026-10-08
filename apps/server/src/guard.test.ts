import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';

import { createGuard } from './guard.js';
import type { GuardEnv, GuardOptions } from './guard.js';

const verifiers: Pick<GuardOptions, 'verifyAppCheck' | 'verifyIdToken'> = {
  verifyAppCheck: async (token) => {
    if (token !== 'good-app') throw new Error('bad app check');
  },
  verifyIdToken: async (token) => {
    if (token !== 'good-id') throw new Error('bad id token');
    return { uid: 'user-1' };
  },
};

function appWith(required: boolean) {
  const app = new Hono<GuardEnv>();
  app.use('/x', createGuard({ required, ...verifiers }));
  app.post('/x', (c) => c.json({ key: c.get('clientKey') }));
  return app;
}

const goodHeaders = {
  'X-Firebase-AppCheck': 'good-app',
  Authorization: 'Bearer good-id',
};

test('required: missing tokens is 401', async () => {
  const res = await appWith(true).request('/x', { method: 'POST' });
  assert.equal(res.status, 401);
  const body = (await res.json()) as { code: string };
  assert.equal(body.code, 'UNAUTHENTICATED');
});

test('required: bad App Check token is 401', async () => {
  const res = await appWith(true).request('/x', {
    method: 'POST',
    headers: { ...goodHeaders, 'X-Firebase-AppCheck': 'forged' },
  });
  assert.equal(res.status, 401);
});

test('required: bad ID token is 401', async () => {
  const res = await appWith(true).request('/x', {
    method: 'POST',
    headers: { ...goodHeaders, Authorization: 'Bearer forged' },
  });
  assert.equal(res.status, 401);
});

test('required: valid tokens pass and key by uid', async () => {
  const res = await appWith(true).request('/x', {
    method: 'POST',
    headers: goodHeaders,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { key: 'uid:user-1' });
});

test('not required: no tokens pass and key by IP', async () => {
  const res = await appWith(false).request('/x', {
    method: 'POST',
    headers: { 'X-Forwarded-For': '203.0.113.7, 10.0.0.1' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { key: 'ip:203.0.113.7' });
});
