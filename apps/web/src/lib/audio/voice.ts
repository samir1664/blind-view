/**
 * Speech language + voice picking. Root fix for "no sound on a new device".
 *
 * Old behaviour: no language setting at all, and the voice picker chose by
 * macOS-only voice *names* (Samantha, Alex, ...). On a judge's phone, a
 * Windows laptop, or a system whose language is not English, those names
 * do not exist — so speech could silently pick a wrong-language voice or
 * nothing at all, and the user heard nothing.
 *
 * New rules:
 * - Language defaults to the *system* language (navigator.language), never
 *   a hardcoded en-US. A saved language of "system" means "follow the device".
 * - Voice picking is by *language tag*, with fallbacks: exact locale →
 *   language prefix → any English → any usable voice. A saved voice URI
 *   from another device is ignored when it does not exist here — it never
 *   blocks speech.
 * - Novelty/joke voices are never auto-picked (same blocklist as AudioEngine).
 * - Pure functions, no DOM except navigator.language (guarded for tests).
 */

export const SYSTEM_LANGUAGE = 'system';

/** Languages offered in Settings. Narration text is English; a non-English
 *  voice is still useful (most system voices are bilingual), and if none
 *  exists the cloud voice speaks instead of silence. */
export const SUPPORTED_LANGUAGES = [
  { value: 'system', label: 'System default' },
  { value: 'en', label: 'English' },
  { value: 'en-US', label: 'English (United States)' },
  { value: 'en-IN', label: 'English (India)' },
  { value: 'en-GB', label: 'English (United Kingdom)' },
  { value: 'hi-IN', label: 'Hindi (India)' },
  { value: 'es-ES', label: 'Spanish (Spain)' },
  { value: 'fr-FR', label: 'French (France)' },
  { value: 'de-DE', label: 'German (Germany)' },
] as const;

export function normalizeLanguageTag(tag: string): string {
  return tag.trim().replace(/_/g, '-');
}

export function languagePrefix(tag: string): string {
  return normalizeLanguageTag(tag).split('-')[0]?.toLowerCase() ?? '';
}

/**
 * Resolve the language to actually speak/listen in.
 * @param navigatorLanguage - for tests only: pass a string to simulate that
 * navigator language, null to simulate no navigator. Omitted = use the real
 * navigator (Node 23 test runs have navigator.language='en-US', so the
 * no-navigator case must be simulated with null, not assumed).
 */
export function resolveSpeechLanguage(explicit?: string | null, navigatorLanguage?: string | null): string {
  const value = (explicit ?? SYSTEM_LANGUAGE).trim();
  if (value && value.toLowerCase() !== SYSTEM_LANGUAGE) return normalizeLanguageTag(value);
  if (navigatorLanguage !== undefined) {
    return navigatorLanguage ? normalizeLanguageTag(navigatorLanguage) : 'en';
  }
  if (typeof navigator !== 'undefined' && navigator.language) {
    return normalizeLanguageTag(navigator.language);
  }
  return 'en';
}

const NOVELTY_VOICES =
  /^(albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|hysterical|jester|junior|organ|princess|ralph|superstar|trinoids|whisper|wobble|zarvox|fred|kathy|agnes|victoria|bruce|grandma|grandpa|rocko|shelley|sandy|eddy|flo|reed|rina)\b/i;

export function isUsableVoiceName(name: string): boolean {
  return !NOVELTY_VOICES.test(name);
}

/** Preferred voices, in order — only used to break ties within one language. */
const PREFERRED_VOICES = [
  'Samantha', 'Alex', 'Daniel', 'Karen', 'Serena', 'Moira', 'Tessa', 'Fiona',
  'Rishi', 'Google US English', 'Microsoft Aria', 'Microsoft Zira',
];

export interface VoiceLike {
  name: string;
  lang: string;
  voiceURI: string;
}

export interface PickVoiceOptions {
  language: string;
  /** Saved voice URI from settings. Honoured only if it exists on this device. */
  savedUri?: string | null;
}

function byPreference(a: VoiceLike, b: VoiceLike): number {
  const rank = (v: VoiceLike) => {
    const i = PREFERRED_VOICES.indexOf(v.name);
    return i === -1 ? PREFERRED_VOICES.length : i;
  };
  return rank(a) - rank(b);
}

/**
 * Pick the best voice for `language` from the voices this device actually has.
 * Never throws, never returns a novelty voice, never fails because a saved
 * URI belongs to another device.
 */
export function pickVoice(voices: VoiceLike[], opts: PickVoiceOptions): VoiceLike | null {
  const usable = voices.filter((v) => isUsableVoiceName(v.name));
  if (usable.length === 0) return null;
  if (opts.savedUri) {
    const saved = usable.find((v) => v.voiceURI === opts.savedUri);
    if (saved) return saved;
  }
  const language = normalizeLanguageTag(opts.language);
  const prefix = languagePrefix(language);
  const exact = usable
    .filter((v) => normalizeLanguageTag(v.lang).toLowerCase() === language.toLowerCase())
    .sort(byPreference);
  if (exact[0]) return exact[0];
  const samePrefix = usable
    .filter((v) => languagePrefix(v.lang) === prefix)
    .sort(byPreference);
  if (samePrefix[0]) return samePrefix[0];
  // Narration text is English: any English voice beats silence / wrong-language.
  const english = usable
    .filter((v) => languagePrefix(v.lang) === 'en')
    .sort(byPreference);
  if (english[0]) return english[0];
  return [...usable].sort(byPreference)[0] ?? null;
}

/** True when this device has a voice that matches the language (exact or prefix). */
export function hasVoiceForLanguage(voices: VoiceLike[], language: string): boolean {
  const resolved = normalizeLanguageTag(resolveSpeechLanguage(language));
  const prefix = languagePrefix(resolved);
  return voices.some(
    (v) =>
      isUsableVoiceName(v.name) &&
      (normalizeLanguageTag(v.lang).toLowerCase() === resolved.toLowerCase() ||
        languagePrefix(v.lang) === prefix),
  );
}
