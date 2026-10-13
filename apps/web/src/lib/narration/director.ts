import { Priority } from '../audio/AudioEngine';
import type { PriorityLevel } from '../audio/AudioEngine';
import type { EarconType } from '../audio/earcons';
import type { PathGuidance, SceneEvent, TranscriptSource } from '../../types';
import type { TerrainReport } from '../vision/terrain';

/**
 * The narration director.
 *
 * Without this, the two tiers talk over each other: the detector shouts
 * "Person, close, ahead" while the cloud says "A man is sitting in front of
 * you". Both are correct and together they are unusable.
 *
 * The director owns the single output voice. It decides what gets said, in
 * what order, how often, and what gets merged into one breath — so the user
 * hears a companion narrating a walk rather than two machines reporting.
 */

export interface Utterance {
  text: string;
  priority: PriorityLevel;
  source: TranscriptSource;
  earcon?: EarconType;
  pan?: number;
  dedupeKey?: string;
  cooldownMs?: number;
  ttlMs?: number;
}

export interface DirectorOptions {
  /** Minimum gap between ordinary call-outs. Urgent ones ignore this. */
  minGapMs: number;
}

/** Above this urgency an event interrupts whatever is being spoken. */
const INTERRUPT_URGENCY = 0.85;

/** Don't repeat an identical phrase within this window. */
const PHRASE_COOLDOWN_MS = 5000;

/** How many spoken lines to retain as context for the cloud prompt. */
const HISTORY_SIZE = 6;

export class NarrationDirector {
  private spokenPhrases = new Map<string, number>();
  private history: string[] = [];
  private contextLines: string[] = [];

  constructor(private options: DirectorOptions) {}

  setOptions(options: Partial<DirectorOptions>): void {
    this.options = { ...this.options, ...options };
  }

  reset(): void {
    this.spokenPhrases.clear();
    this.history = [];
    this.contextLines = [];
  }

  /** Lines already spoken, newest first — sent to the model so it won't repeat them. */
  recentLines(): string[] {
    return [...this.history];
  }

  /** Record something the cloud tier said, so local output can avoid echoing it. */
  noteSpoken(text: string): void {
    this.history = [text, ...this.history].slice(0, HISTORY_SIZE);
  }

  /**
   * Turn this frame's observations into at most one thing to say.
   */
  submit(
    events: SceneEvent[],
    guidance: PathGuidance | null,
    terrain: TerrainReport | null,
    now: number,
  ): Utterance[] {
    const output: Utterance[] = [];

    // ── Urgent: bypass all pacing and interrupt ──────────────
    // A break in the ground is weighed alongside closing hazards, because a
    // step down at your feet is every bit as time-critical as a car.
    // F5: only imminent danger is spoken locally, as full sentence + earcon.
    // Terrain/path status never speaks directly — it is context for narrator.
    const urgentEvent = events.find(
      (event) => event.kind === 'imminent' && event.urgency >= INTERRUPT_URGENCY,
    );
    const urgent = urgentEvent
      ? { phrase: urgentEvent.phrase, pan: urgentEvent.pan }
      : null;

    if (urgent && !this.isRepeat(urgent.phrase, now)) {
      this.mark(urgent.phrase, now);
      output.push({
        text: urgent.phrase,
        priority: Priority.HAZARD,
        source: 'hazard',
        earcon: 'hazard',
        pan: urgent.pan,
        // A warning that arrives late is worse than one that never arrives.
        ttlMs: 2000,
      });
      return output;
    }

    // ── Ordinary: NOT spoken locally (F5). Local events become context for narrator. ──
    // Collect context lines for /api/scene localEvents; narrator phrases them in full sentences.
    for (const event of events) {
      if (this.contextLines.length >= 6) this.contextLines.shift();
      this.contextLines.push(event.phrase);
    }
    if (guidance && guidance.aheadBlocked) {
      this.contextLines.push(`path ${guidance.clearest} side is more open`);
    }
    if (terrain && terrain.aheadBlocked) {
      this.contextLines.push('ground ahead looks blocked');
    }
    return output;
  }

  /** Local events as context for narrator (drained by caller for /api/scene). */
  takeContext(): string[] {
    const out = [...this.contextLines];
    this.contextLines = [];
    return out;
  }

  private isRepeat(phrase: string, now: number): boolean {
    const last = this.spokenPhrases.get(phrase);
    return last !== undefined && now - last < PHRASE_COOLDOWN_MS;
  }

  private mark(phrase: string, now: number): void {
    this.spokenPhrases.set(phrase, now);
    if (this.spokenPhrases.size > 40) {
      for (const [key, at] of this.spokenPhrases) {
        if (now - at > PHRASE_COOLDOWN_MS * 2) this.spokenPhrases.delete(key);
      }
    }
  }
}
