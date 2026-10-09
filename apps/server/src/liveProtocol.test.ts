import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildLiveSetup,
  LIVE_TOOL_NAMES,
  mapClientMessage,
  mapUpstreamMessage,
} from './liveProtocol.js';

test('setup is server-owned: fixed model path, tools, transcription, compression', () => {
  const { setup } = buildLiveSetup({ project: 'p', location: 'us-central1', model: 'm' });
  assert.equal(setup.model, 'projects/p/locations/us-central1/publishers/google/models/m');
  const names = setup.tools[0]!.functionDeclarations.map((f) => f.name);
  assert.deepEqual([...names].sort(), [...LIVE_TOOL_NAMES].sort());
  assert.ok(setup.contextWindowCompression.slidingWindow);
  assert.ok(setup.inputAudioTranscription);
  assert.ok(setup.outputAudioTranscription);
  assert.match(setup.systemInstruction.parts[0]!.text, /\[SAY\]/);
  assert.equal(setup.sessionResumption.handle, undefined);
});

test('setup carries a resumption handle when reconnecting', () => {
  const { setup } = buildLiveSetup({ project: 'p', location: 'l', model: 'm', resumeHandle: 'h1' });
  assert.equal(setup.sessionResumption.handle, 'h1');
});

test('client audio becomes realtime PCM input', () => {
  const out = mapClientMessage({ type: 'audio', data: 'AAAA' });
  assert.deepEqual(out, {
    realtimeInput: { audio: { data: 'AAAA', mimeType: 'audio/pcm;rate=16000' } },
  });
});

test('client say becomes a [SAY] user turn, trimmed and bounded', () => {
  const out = mapClientMessage({ type: 'say', text: `  ${'a'.repeat(3000)}  ` }) as {
    clientContent: { turns: Array<{ parts: Array<{ text: string }> }> };
  };
  const text = out.clientContent.turns[0]!.parts[0]!.text;
  assert.ok(text.startsWith('[SAY] '));
  assert.ok(text.length <= 1206);
});

test('client tool_result becomes a toolResponse', () => {
  const out = mapClientMessage({ type: 'tool_result', id: 'c1', name: 'where_am_i', response: { say: 'Hi' } });
  assert.deepEqual(out, {
    toolResponse: { functionResponses: [{ id: 'c1', name: 'where_am_i', response: { say: 'Hi' } }] },
  });
});

test('client garbage is rejected', () => {
  assert.equal(mapClientMessage({ type: 'setup', model: 'x' }), null);
  assert.equal(mapClientMessage({ type: 'audio', data: 'not base64!!' }), null);
  assert.equal(mapClientMessage({ type: 'audio', data: 'A'.repeat(200_000) }), null);
  assert.equal(mapClientMessage({ type: 'tool_result', id: 'c1', name: 'rm_rf', response: {} }), null);
  assert.equal(mapClientMessage('nope'), null);
});

test('upstream messages map to the small client protocol', () => {
  assert.deepEqual(mapUpstreamMessage({ setupComplete: {} }), [{ type: 'ready' }]);
  assert.deepEqual(
    mapUpstreamMessage({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'QUJD' } }] },
        outputTranscription: { text: 'Hello' },
      },
    }),
    [
      { type: 'audio', data: 'QUJD' },
      { type: 'transcript', role: 'model', text: 'Hello' },
    ],
  );
  assert.deepEqual(mapUpstreamMessage({ serverContent: { interrupted: true } }), [{ type: 'interrupted' }]);
  assert.deepEqual(mapUpstreamMessage({ serverContent: { turnComplete: true } }), [{ type: 'turn_complete' }]);
  assert.deepEqual(mapUpstreamMessage({ serverContent: { inputTranscription: { text: 'find my keys' } } }), [
    { type: 'transcript', role: 'user', text: 'find my keys' },
  ]);
  assert.deepEqual(
    mapUpstreamMessage({ toolCall: { functionCalls: [{ id: 'c1', name: 'find_object', args: { name: 'keys' } }] } }),
    [{ type: 'tool_call', calls: [{ id: 'c1', name: 'find_object', args: { name: 'keys' } }] }],
  );
});
