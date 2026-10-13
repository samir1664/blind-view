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

export function accelMagnitude(x: number, y: number, z: number): number {
  // Remove gravity (~9.8) roughly: magnitude of (total - gravity) is not exact,
  // so caller passes accelerationIncludingGravity magnitude and we threshold on variation.
  return Math.sqrt(x * x + y * y + z * z) / 9.8;
}
