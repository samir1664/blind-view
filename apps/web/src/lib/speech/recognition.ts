/**
 * Voice input for hands-free operation.
 *
 * Uses the browser's built-in SpeechRecognition — free, no API key, and on
 * Chrome/Safari it is already the engine the user's assistive tech relies on.
 * Push-to-talk rather than always-listening: continuous recognition fights
 * with screen readers and drains the battery.
 */

import type { NarrationMode } from '../../types';

interface SpeechRecognitionAlternativeLike {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionResultLike {
  readonly length: number;
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike extends Event {
  results: {
    readonly length: number;
    [index: number]: SpeechRecognitionResultLike;
  };
}

interface SpeechRecognitionErrorEventLike extends Event {
  error: string;
}

interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getConstructor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isVoiceInputSupported(): boolean {
  return getConstructor() !== null;
}

export class VoiceInputError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'VoiceInputError';
  }
}

const FRIENDLY_ERRORS: Record<string, string> = {
  'not-allowed': 'Microphone access was denied.',
  'service-not-allowed': 'Microphone access was denied.',
  'no-speech': "I didn't hear anything.",
  aborted: 'Listening stopped.',
  network: 'Voice recognition needs a connection.',
  'audio-capture': 'No microphone found.',
};

/** Listens for a single phrase and resolves with the transcript. */
export function listenOnce(
  lang = 'en-US',
  timeoutMs = 8000,
): { promise: Promise<string>; cancel: () => void } {
  const Ctor = getConstructor();

  if (!Ctor) {
    return {
      promise: Promise.reject(
        new VoiceInputError(
          'Voice input is not supported in this browser.',
          'unsupported',
        ),
      ),
      cancel: () => undefined,
    };
  }

  const recognition = new Ctor();
  recognition.lang = lang;
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  let settled = false;
  let timer: number | undefined;

  const promise = new Promise<string>((resolve, reject) => {
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      fn();
    };

    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript?.trim() ?? '';
      done(() =>
        transcript
          ? resolve(transcript)
          : reject(new VoiceInputError("I didn't catch that.", 'no-speech')),
      );
    };

    recognition.onerror = (event) => {
      done(() =>
        reject(
          new VoiceInputError(
            FRIENDLY_ERRORS[event.error] ?? 'Voice input failed.',
            event.error,
          ),
        ),
      );
    };

    recognition.onend = () => {
      done(() =>
        reject(new VoiceInputError("I didn't catch that.", 'no-speech')),
      );
    };

    timer = window.setTimeout(() => {
      recognition.abort();
      done(() => reject(new VoiceInputError('Listening timed out.', 'timeout')));
    }, timeoutMs);

    try {
      recognition.start();
    } catch {
      done(() =>
        reject(new VoiceInputError('Could not start listening.', 'start-failed')),
      );
    }
  });

  return {
    promise,
    cancel: () => {
      try {
        recognition.abort();
      } catch {
        /* already stopped */
      }
    },
  };
}

export interface ParsedCommand {
  mode: NarrationMode;
  query?: string;
}

const FIND_PATTERNS = [
  /^(?:please\s+)?(?:find|locate|look for|search for|where(?:'s| is| are)(?: the| my| a)?)\s+(.+)$/i,
  /^(?:can you )?(?:help me )?find\s+(.+)$/i,
];

/** Maps a spoken phrase onto one of the narration modes. */
export function parseCommand(transcript: string): ParsedCommand {
  const text = transcript.trim().replace(/[.!?]+$/, '');
  const lower = text.toLowerCase();

  for (const pattern of FIND_PATTERNS) {
    const match = lower.match(pattern);
    if (match?.[1]) {
      return { mode: 'find', query: match[1].trim() };
    }
  }

  if (
    /\b(read|says?|written|sign|label|menu|text)\b/.test(lower) &&
    !/\b(ready|already)\b/.test(lower)
  ) {
    return { mode: 'text' };
  }

  if (/\b(money|cash|note|notes|bill|bills|currency|change|coin|coins)\b/.test(lower)) {
    return { mode: 'currency' };
  }

  if (
    /\b(describe|around me|in front of me|what'?s here|look around|surroundings|scene)\b/.test(
      lower,
    )
  ) {
    return { mode: 'scene' };
  }

  return { mode: 'ask', query: text };
}
