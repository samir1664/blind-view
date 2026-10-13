import assert from 'node:assert/strict';
import { test } from 'node:test';

import { base64ToFloat32, downsample, floatToPcm16Base64, rms } from './pcm';

test('downsample 48 kHz to 16 kHz keeps one third of the samples and averages', () => {
  const input = new Float32Array([0.3, 0.3, 0.3, -0.6, -0.6, -0.6]);
  const out = downsample(input, 48000, 16000);
  assert.equal(out.length, 2);
  assert.ok(Math.abs(out[0]! - 0.3) < 1e-6);
  assert.ok(Math.abs(out[1]! + 0.6) < 1e-6);
});

test('downsample is identity at equal rates', () => {
  const input = new Float32Array([0.1, -0.2]);
  assert.deepEqual(Array.from(downsample(input, 16000, 16000)), Array.from(input));
});

test('PCM16 round trip through base64 is near-lossless and clamps', () => {
  const input = new Float32Array([0, 0.5, -0.5, 1.5, -1.5]);
  const b64 = floatToPcm16Base64(input);
  const back = base64ToFloat32(b64);
  assert.equal(back.length, 5);
  assert.ok(Math.abs(back[1]! - 0.5) < 1e-3);
  assert.ok(Math.abs(back[2]! + 0.5) < 1e-3);
  assert.ok(back[3]! <= 1 && back[3]! > 0.99);
  assert.ok(back[4]! >= -1 && back[4]! < -0.99);
});

test('PCM16 is little-endian as the Live API requires', () => {
  const b64 = floatToPcm16Base64(new Float32Array([1]));
  const bytes = Buffer.from(b64, 'base64');
  assert.deepEqual([...bytes], [0xff, 0x7f]);
});

test('rms of silence is zero and of a full-scale square is one', () => {
  assert.equal(rms(new Float32Array(10)), 0);
  assert.ok(Math.abs(rms(new Float32Array([1, -1, 1, -1])) - 1) < 1e-9);
});
