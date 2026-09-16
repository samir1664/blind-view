/**
 * Frame quality + change scoring.
 *
 * Every cloud call costs money and ~1–2 seconds. Sending a motion-blurred
 * frame, a shot of the inside of a pocket, or the exact same hallway for the
 * twentieth time wastes all three. This picks moments worth describing.
 *
 * All of it runs on a 64×48 thumbnail, so the cost is negligible.
 */

const W = 64;
const H = 48;

export interface FrameScore {
  /** Mean absolute gradient, 0…1. Below ~0.012 is visibly blurred. */
  sharpness: number;
  /** Mean absolute difference from the last scored frame, 0…1. */
  change: number;
  /** Mean luminance, 0…1. */
  brightness: number;
  /** False when the frame is too dark, blown out, or too blurred to describe. */
  usable: boolean;
}

export interface ScorerOptions {
  minSharpness?: number;
  minBrightness?: number;
  maxBrightness?: number;
}

export class FrameScorer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private previous: Float32Array | null = null;

  constructor(private options: ScorerOptions = {}) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  reset(): void {
    this.previous = null;
  }

  score(source: CanvasImageSource): FrameScore | null {
    const ctx = this.ctx;
    if (!ctx) return null;

    try {
      ctx.drawImage(source, 0, 0, W, H);
    } catch {
      return null;
    }

    const { data } = ctx.getImageData(0, 0, W, H);
    const gray = new Float32Array(W * H);

    let sum = 0;
    for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
      // Rec. 601 luma — cheap and good enough for these heuristics.
      const value =
        0.299 * (data[p] ?? 0) +
        0.587 * (data[p + 1] ?? 0) +
        0.114 * (data[p + 2] ?? 0);
      gray[i] = value;
      sum += value;
    }

    const brightness = sum / gray.length / 255;

    // Mean absolute gradient. Blur flattens local differences, so this drops
    // sharply when the camera is moving or out of focus.
    let gradient = 0;
    let gradientCount = 0;
    for (let y = 0; y < H - 1; y += 1) {
      for (let x = 0; x < W - 1; x += 1) {
        const i = y * W + x;
        const here = gray[i] ?? 0;
        gradient += Math.abs((gray[i + 1] ?? 0) - here);
        gradient += Math.abs((gray[i + W] ?? 0) - here);
        gradientCount += 2;
      }
    }
    const sharpness = gradientCount ? gradient / gradientCount / 255 : 0;

    let change = 1;
    if (this.previous) {
      let diff = 0;
      for (let i = 0; i < gray.length; i += 1) {
        diff += Math.abs((gray[i] ?? 0) - (this.previous[i] ?? 0));
      }
      change = diff / gray.length / 255;
    }
    this.previous = gray;

    const {
      minSharpness = 0.012,
      minBrightness = 0.06,
      maxBrightness = 0.97,
    } = this.options;

    return {
      sharpness,
      change,
      brightness,
      usable:
        brightness >= minBrightness &&
        brightness <= maxBrightness &&
        sharpness >= minSharpness,
    };
  }
}

/** A short spoken explanation of why a frame was rejected, or null if it is fine. */
export function explainUnusable(score: FrameScore): string | null {
  if (score.brightness < 0.06) return 'Too dark to see.';
  if (score.brightness > 0.97) return 'Too bright to see.';
  if (score.sharpness < 0.012) return 'Hold the camera steady.';
  return null;
}
