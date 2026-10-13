import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  hasVoiceForLanguage,
  pickVoice,
  resolveSpeechLanguage,
  type VoiceLike,
} from './voice.js';

const voices: VoiceLike[] = [
  { name: 'Samantha', lang: 'en-US', voiceURI: 'uri-samantha' },
  { name: 'Rishi', lang: 'en-IN', voiceURI: 'uri-rishi' },
  { name: 'Lekha', lang: 'hi-IN', voiceURI: 'uri-lekha' },
  { name: 'Bubbles', lang: 'en-US', voiceURI: 'uri-bubbles' },
];

test('resolveSpeechLanguage: system falls back to en without navigator', () => {
  // Node 23 has a real navigator (en-US), so simulate "no navigator" with null.
  assert.equal(resolveSpeechLanguage('system', null), 'en');
  assert.equal(resolveSpeechLanguage(null, null), 'en');
  assert.equal(resolveSpeechLanguage('hi_IN'), 'hi-IN');
  assert.equal(resolveSpeechLanguage('system', 'en-IN'), 'en-IN');
});

test('pickVoice: exact locale wins', () => {
  assert.equal(pickVoice(voices, { language: 'en-IN' })?.voiceURI, 'uri-rishi');
  assert.equal(pickVoice(voices, { language: 'hi-IN' })?.voiceURI, 'uri-lekha');
});

test('pickVoice: prefix match when exact locale missing', () => {
  const noExact = voices.filter((v) => v.voiceURI !== 'uri-rishi');
  assert.equal(pickVoice(noExact, { language: 'en-IN' })?.voiceURI, 'uri-samantha');
});

test('pickVoice: non-English request falls back to English, never silence', () => {
  const englishOnly = voices.filter((v) => v.lang.startsWith('en')); 
  assert.equal(pickVoice(englishOnly, { language: 'fr-FR' })?.lang, 'en-US');
});

test('pickVoice: saved URI from another device is ignored, not fatal', () => {
  assert.equal(
    pickVoice(voices, { language: 'en-IN', savedUri: 'uri-from-judges-laptop' })?.voiceURI,
    'uri-rishi',
  );
});

test('pickVoice: saved URI on this device wins', () => {
  assert.equal(
    pickVoice(voices, { language: 'en-US', savedUri: 'uri-lekha' })?.voiceURI,
    'uri-lekha',
  );
});

test('pickVoice: novelty voices never auto-picked', () => {
  const onlyJoke: VoiceLike[] = [{ name: 'Bubbles', lang: 'en-US', voiceURI: 'uri-bubbles' }];
  assert.equal(pickVoice(onlyJoke, { language: 'en-US' }), null);
});

test('hasVoiceForLanguage: exact and prefix', () => {
  assert.equal(hasVoiceForLanguage(voices, 'hi-IN'), true);
  assert.equal(hasVoiceForLanguage(voices, 'hi'), true);
  assert.equal(hasVoiceForLanguage(voices, 'fr-FR'), false);
});
