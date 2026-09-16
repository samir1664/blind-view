import { create } from 'zustand';

import type {
  EngineStatus,
  PlaceContext,
  TranscriptEntry,
  TranscriptSource,
} from '../types';

/** Transient per-run state. Never persisted. */

const MAX_TRANSCRIPT = 60;

export interface SessionState {
  status: EngineStatus;
  error: string | null;
  transcript: TranscriptEntry[];
  /** Null while unknown; false means GEMINI_API_KEY is missing on the server. */
  visionConfigured: boolean | null;
  /** Where the user currently is, e.g. indoor > mall > escalator. */
  place: PlaceContext | null;
  busy: boolean;
  listening: boolean;

  setStatus: (status: EngineStatus) => void;
  setError: (error: string | null) => void;
  setVisionConfigured: (configured: boolean) => void;
  setPlace: (place: PlaceContext | null) => void;
  setBusy: (busy: boolean) => void;
  setListening: (listening: boolean) => void;
  addLine: (source: TranscriptSource, text: string) => void;
  clearTranscript: () => void;
}

export const useSession = create<SessionState>()((set) => ({
  status: 'idle',
  error: null,
  transcript: [],
  visionConfigured: null,
  place: null,
  busy: false,
  listening: false,

  setStatus: (status) => set({ status }),
  setError: (error) => set({ error }),
  setVisionConfigured: (visionConfigured) => set({ visionConfigured }),
  setPlace: (place) => set({ place }),
  setBusy: (busy) => set({ busy }),
  setListening: (listening) => set({ listening }),

  addLine: (source, text) =>
    set((state) => {
      const last = state.transcript[0];
      // Collapse an immediate exact repeat rather than filling the log with it.
      if (last && last.source === source && last.text === text) return state;

      const entry: TranscriptEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        at: Date.now(),
        source,
        text,
      };
      return { transcript: [entry, ...state.transcript].slice(0, MAX_TRANSCRIPT) };
    }),

  clearTranscript: () => set({ transcript: [] }),
}));
