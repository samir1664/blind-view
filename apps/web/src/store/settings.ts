import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { Sensitivity } from '../lib/vision/tracking';
import type { Verbosity } from '../types';

export interface SettingsState {
  /** Null until the user has heard and accepted the safety disclaimer. */
  disclaimerAcceptedAt: number | null;

  hazardsEnabled: boolean;
  narrationEnabled: boolean;
  earconsEnabled: boolean;

  /**
   * Continuous walking-guide narration rather than periodic scene snapshots.
   * This is the mode the product is really for.
   */
  walkMode: boolean;
  /** Suggest sidesteps when the way ahead is obstructed. */
  pathGuidanceEnabled: boolean;
  /**
   * Identify the kind of place (mall, kitchen, road crossing) and narrate
   * using that place's vocabulary and hazards.
   */
  placeAwareEnabled: boolean;
  /**
   * Depth-based terrain detection: steps, kerbs, drop-offs and unnamed
   * obstacles the object detector has no class for.
   */
  terrainEnabled: boolean;

  sensitivity: Sensitivity;
  verbosity: Verbosity;

  /** Gap between automatic scene descriptions. */
  narrationIntervalMs: number;
  /** Minimum gap between on-device call-outs. Urgent ones ignore it. */
  calloutGapMs: number;
  /** Gap between on-device detector passes. 125 ms ≈ 8 fps. */
  detectIntervalMs: number;
  /** Minimum gap before repeating the same hazard. */
  hazardCooldownMs: number;
  /** Detector confidence floor. */
  minConfidence: number;

  speechRate: number;
  speechVolume: number;
  voiceURI: string | null;
  /**
   * Speech language: 'system' (default) follows the device language
   * (navigator.language). A saved value from another device never blocks
   * speech: voice picking falls back by language when the exact voice is
   * missing. See lib/audio/voice.ts.
   */
  language: string;

  cameraFacing: 'environment' | 'user';
  /** Sighted helpers and developers want the preview; blind users do not. */
  showPreview: boolean;

  acceptDisclaimer: () => void;
  update: (patch: Partial<SettingsState>) => void;
  reset: () => void;
}

const DEFAULTS = {
  disclaimerAcceptedAt: null,
  hazardsEnabled: true,
  narrationEnabled: true,
  earconsEnabled: true,
  walkMode: true,
  pathGuidanceEnabled: true,
  placeAwareEnabled: true,
  terrainEnabled: true,
  sensitivity: 'medium' as Sensitivity,
  verbosity: 'normal' as Verbosity,
  // Guide narration is background colour under a fast local layer, so it can
  // run often without crowding the moving-object call-outs.
  narrationIntervalMs: 6000,
  calloutGapMs: 1600,
  detectIntervalMs: 125,
  hazardCooldownMs: 5000,
  minConfidence: 0.5,
  // Slightly fast: experienced screen-reader users listen far above 1×.
  speechRate: 1.15,
  speechVolume: 1,
  voiceURI: null,
  language: 'system',
  cameraFacing: 'environment' as const,
  showPreview: true,
};

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      acceptDisclaimer: () => set({ disclaimerAcceptedAt: Date.now() }),
      update: (patch) => set(patch),
      reset: () => set(DEFAULTS),
    }),
    {
      name: 'blind-view.settings',
      version: 3,
      /**
       * Without this, bumping the version makes zustand discard everything the
       * user had configured — including `disclaimerAcceptedAt`, so they would
       * be shown the safety screen again after every update. Merging over the
       * defaults keeps their choices and fills in whatever is new.
       */
      migrate: (persisted) => ({
        ...DEFAULTS,
        ...(persisted && typeof persisted === 'object' ? persisted : {}),
      }),
    },
  ),
);
