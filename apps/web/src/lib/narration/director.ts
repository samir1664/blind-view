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

/** Never merge more than this many observations into one sentence. */
const MAX_MERGED = 2;

/** Don't repeat the same steer more often than this. */
const GUIDANCE_COOLDOWN_MS = 5000;

/** Don't repeat an identical phrase within this window. */
const PHRASE_COOLDOWN_MS = 5000;

/** How many spoken lines to retain as context for the cloud prompt. */
const HISTORY_SIZE = 6;

export class NarrationDirector {
  private lastSpokeAt = 0;
  private lastGuidanceAt = 0;
  private lastGuidancePhrase: string | null = null;
  private spokenPhrases = new Map<string, number>();
  private history: string[] = [];

  constructor(private options: DirectorOptions) {}

  setOptions(options: Partial<DirectorOptions>): void {
    this.options = { ...this.options, ...options };
  }

  reset(): void {
    this.lastSpokeAt = 0;
    this.lastGuidanceAt = 0;
    this.lastGuidancePhrase = null;
    this.spokenPhrases.clear();
    this.history = [];
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
    const urgentEvent = events.find(
      (event) => event.urgency >= INTERRUPT_URGENCY,
    );
    const urgentTerrain =
      terrain?.phrase && terrain.urgency >= INTERRUPT_URGENCY ? terrain : null;

    const urgent =
      urgentTerrain &&
      (!urgentEvent || urgentTerrain.urgency > urgentEvent.urgency)
        ? { phrase: urgentTerrain.phrase as string, pan: 0 }
        : urgentEvent
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

    // ── Ordinary: paced, merged into a single sentence ───────
    if (now - this.lastSpokeAt < this.options.minGapMs) return output;

    const parts: string[] = [];
    let pan = 0;
    let topUrgency = 0;

    for (const event of events) {
      if (parts.length >= MAX_MERGED) break;
      if (this.isRepeat(event.phrase, now)) continue;
      this.mark(event.phrase, now);
      parts.push(event.phrase);
      if (event.urgency > topUrgency) {
        topUrgency = event.urgency;
        pan = event.pan;
      }
    }

    // A steer is appended to whatever we were already saying, so the user
    // hears "Dog coming towards you, keep a bit left" as one instruction.
    // Terrain wins over object steering: the ground matters more than a bin.
    const steer = terrain?.phrase ?? guidance?.phrase ?? null;
    const steerUrgency = terrain?.phrase
      ? terrain.urgency
      : (guidance?.urgency ?? 0);

    if (
      steer &&
      (steer !== this.lastGuidancePhrase ||
        now - this.lastGuidanceAt >= GUIDANCE_COOLDOWN_MS)
    ) {
      this.lastGuidanceAt = now;
      this.lastGuidancePhrase = steer;
      parts.push(steer);
      topUrgency = Math.max(topUrgency, steerUrgency);
    }

    if (parts.length === 0) return output;

    const text = joinPhrases(parts);
    this.lastSpokeAt = now;
    this.noteSpoken(text);

    output.push({
      text,
      priority: topUrgency >= 0.5 ? Priority.HAZARD : Priority.ALERT,
      source: 'guide',
      earcon: topUrgency >= 0.5 ? 'hazard' : 'alert',
      pan,
      ttlMs: 3000,
    });

    return output;
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

/**
 * "Man passing on your right." + "Keep a bit left."
 *   → "Man passing on your right, keep a bit left."
 */
function joinPhrases(parts: string[]): string {
  const cleaned = parts
    .map((part) => part.trim().replace(/[.]+$/, ''))
    .filter(Boolean);
  if (cleaned.length === 0) return '';

  const [head, ...rest] = cleaned;
  const tail = rest.map((part) =>
    // Keep acronyms and "I" intact; only de-capitalise ordinary words.
    /^[A-Z][a-z]/.test(part) ? part.charAt(0).toLowerCase() + part.slice(1) : part,
  );

  return `${[head, ...tail].join(', ')}.`;
}
