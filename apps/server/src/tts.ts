/** Cloud Text-to-Speech fallback (Chirp 3 HD). Used when Live fails. */
import { env } from './env.js';
import { authHeaders } from './provider.js';

const TTS_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';
const MAX_TEXT = 1200;

/**
 * `languageCode` comes from the client (resolved system language). When it is
 * English we use the known Chirp voice; for any other language we send only
 * the languageCode and let Google pick its default voice for that language —
 * inventing a voice name here would fail the whole request.
 */
export async function synthesizeSpeech(text: string, languageCode = 'en-US'): Promise<string> {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  if (!clean) throw new Error('Empty text.');
  const lang = (languageCode || 'en-US').trim().replace(/_/g, '-');
  const envVoice = process.env.TTS_VOICE?.trim();
  const voice: { languageCode: string; name?: string } = { languageCode: lang };
  if (envVoice) voice.name = envVoice;
  else if (lang.toLowerCase().startsWith('en')) voice.name = 'en-US-Chirp3-HD-Aoede';
  const res = await fetch(TTS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(await authHeaders()),
      // Local ADC (user login) has no quota project by default, so Google
      // rejects TTS with 403 "requires a quota project". Sending it
      // explicitly fixes local dev AND Cloud Run (harmless there).
      ...(env.gcpProject ? { 'x-goog-user-project': env.gcpProject } : {}),
    },
    body: JSON.stringify({
      input: { text: clean },
      voice,
      audioConfig: { audioEncoding: 'MP3', speakingRate: 1.0 },
    }),
  });
  if (!res.ok) {
    // Google's body says WHY (e.g. "API not enabled" vs "permission denied").
    // Without it we only see "403" and have to guess.
    const body = await res.text().catch(() => '');
    throw new Error(`TTS failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = await res.json() as { audioContent?: string };
  if (!data.audioContent) throw new Error('TTS returned no audio.');
  return data.audioContent;
}
