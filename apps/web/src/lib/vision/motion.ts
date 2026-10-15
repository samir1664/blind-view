/** Walking detection from DeviceMotionEvent (step cadence). iOS needs a permission tap at Start. */

export type MotionState = 'still' | 'walking';

/** Simple step detector: acceleration magnitude peaks above threshold, spaced apart. */
export class MotionTracker {
  private lastPeakAt = 0;
  private peaks: number[] = [];
  private walking = false;

  /** Call on each devicemotion event. Returns current walking state. */
  update(accelMag: number, now = Date.now()): MotionState {
    if (accelMag > 1.35 && now - this.lastPeakAt > 280) {
      this.lastPeakAt = now;
      this.peaks.push(now);
    }
    // Keep last 4s of peaks.
    this.peaks = this.peaks.filter((t) => now - t <= 4000);
    // >=3 steps in 4s => walking (cadence ~0.75+ Hz). Else still.
    this.walking = this.peaks.length >= 3;
    return this.walking ? 'walking' : 'still';
  }

  get isWalking(): boolean { return this.walking; }
  /** Approx walking speed for ego-motion compensation (m/s). */
  get walkingSpeedMps(): number { return this.walking ? 1.2 : 0; }
  reset(): void { this.peaks = []; this.walking = false; this.lastPeakAt = 0; }
}

/**
 * Motion-aware narration gate: moving = narrate, still = ask once, then wait.
 *
 * While the user moves, narration runs as normal. When they stand still for
 * STILL_PROMPT_MS, the app pauses narration, asks "How can I help?" ONCE,
 * and waits for a command. When movement resumes, narration restarts with a
 * fresh update. Pure + time-driven, so it is unit-testable without sensors.
 */
export const STILL_PROMPT_MS = 6000;

export type StillnessResult = 'moving' | 'prompt' | 'waiting' | 'resumed';

export class StillnessGate {
  private lastMotionAt: number;
  private prompted = false;
  private waiting = false;

  constructor(private stillMs: number = STILL_PROMPT_MS) {
    this.lastMotionAt = Date.now();
  }

  /** Feed one motion sample. Returns what the caller should do. */
  update(moving: boolean, now = Date.now()): StillnessResult {
    if (moving) {
      const wasWaiting = this.waiting;
      this.lastMotionAt = now;
      this.prompted = false;
      this.waiting = false;
      return wasWaiting ? 'resumed' : 'moving';
    }
    if (this.waiting) return 'waiting';
    if (!this.prompted && now - this.lastMotionAt >= this.stillMs) {
      this.prompted = true;
      this.waiting = true;
      return 'prompt';
    }
    return 'moving';
  }

  get isWaiting(): boolean {
    return this.waiting;
  }

  reset(now = Date.now()): void {
    this.lastMotionAt = now;
    this.prompted = false;
    this.waiting = false;
  }
}

export function accelMagnitude(x: number, y: number, z: number): number {
  // Remove gravity (~9.8) roughly: magnitude of (total - gravity) is not exact,
  // so caller passes accelerationIncludingGravity magnitude and we threshold on variation.
  return Math.sqrt(x * x + y * y + z * z) / 9.8;
}
