import type { DepthRequest, DepthWorkerMessage } from './depth.worker';

/**
 * Main-thread client for the depth worker.
 *
 * Owns three things the worker cannot: capturing the frame, keeping exactly
 * one request in flight, and giving up gracefully on hardware that is too slow
 * to keep up. A depth map that arrives two seconds late describes a kerb the
 * user has already walked over.
 */

/** Model input must be a multiple of 14 (ViT patch size). 196 = 14 × 14. */
export const DEPTH_SIZE_DEFAULT = 196;
/** Fallback for slow devices. 140 = 14 × 10, measured ~2× faster. */
export const DEPTH_SIZE_SMALL = 140;

/** Above this, drop to the smaller input size. */
const SLOW_MS = 600;
/** Above this even when small, the device cannot do this usefully. */
const HOPELESS_MS = 1400;
/** Consecutive slow frames before acting. */
const STRIKES = 3;

export interface DepthMap {
  /** Relative inverse depth: larger means nearer. Not metric. */
  data: Float32Array;
  size: number;
}

export class DepthEstimator {
  private worker: Worker | null = null;
  private pending = new Map<number, (map: DepthMap | null) => void>();
  private seq = 0;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private size = DEPTH_SIZE_DEFAULT;
  private slowStrikes = 0;
  private busy = false;

  /** Set when the device proves too slow, or the model fails to load. */
  disabled = false;
  disabledReason: string | null = null;
  lastInferenceMs = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  private ensureWorker(): Worker | null {
    if (this.disabled) return null;
    if (this.worker) return this.worker;

    try {
      this.worker = new Worker(
        new URL('./depth.worker.ts', import.meta.url),
        { type: 'module' },
      );
    } catch {
      this.disable('Depth estimation is not supported here.');
      return null;
    }

    this.worker.onmessage = (event: MessageEvent<DepthWorkerMessage>) => {
      const message = event.data;

      if (message.type === 'error') {
        // A failure here is almost always the model file being absent.
        this.disable(message.message);
        this.resolveAll(null);
        return;
      }

      if (message.type === 'result') {
        this.lastInferenceMs = message.inferenceMs;
        this.adapt(message.inferenceMs);
        const resolve = this.pending.get(message.id);
        this.pending.delete(message.id);
        resolve?.({
          data: new Float32Array(message.depth),
          size: message.size,
        });
      }
    };

    this.worker.onerror = () => {
      this.disable('Depth worker failed to start.');
      this.resolveAll(null);
    };

    return this.worker;
  }

  /** Returns null when depth is unavailable, busy, or the frame is unusable. */
  async estimate(video: HTMLVideoElement): Promise<DepthMap | null> {
    if (this.disabled || this.busy) return null;

    const worker = this.ensureWorker();
    const ctx = this.ctx;
    if (!worker || !ctx || !video.videoWidth) return null;

    const size = this.size;
    this.canvas.width = size;
    this.canvas.height = size;

    try {
      // Squashing to a square distorts aspect ratio, which the model tolerates
      // and which keeps column indices trivially mappable back to the frame.
      ctx.drawImage(video, 0, 0, size, size);
    } catch {
      return null;
    }

    const pixels = ctx.getImageData(0, 0, size, size).data;
    const buffer = pixels.buffer.slice(0);

    const id = ++this.seq;
    this.busy = true;

    const request: DepthRequest = { type: 'estimate', id, pixels: buffer, size };

    return new Promise<DepthMap | null>((resolve) => {
      this.pending.set(id, resolve);
      worker.postMessage(request, [buffer]);
    }).finally(() => {
      this.busy = false;
    });
  }

  /**
   * Step down to a smaller input, then switch off entirely, rather than
   * letting a slow phone degrade the rest of the pipeline.
   */
  private adapt(inferenceMs: number): void {
    const threshold = this.size === DEPTH_SIZE_DEFAULT ? SLOW_MS : HOPELESS_MS;

    if (inferenceMs <= threshold) {
      this.slowStrikes = 0;
      return;
    }

    this.slowStrikes += 1;
    if (this.slowStrikes < STRIKES) return;
    this.slowStrikes = 0;

    if (this.size === DEPTH_SIZE_DEFAULT) {
      this.size = DEPTH_SIZE_SMALL;
    } else {
      this.disable('This device is too slow for terrain detection.');
    }
  }

  private disable(reason: string): void {
    this.disabled = true;
    this.disabledReason = reason;
    this.worker?.terminate();
    this.worker = null;
  }

  private resolveAll(value: DepthMap | null): void {
    for (const resolve of this.pending.values()) resolve(value);
    this.pending.clear();
    this.busy = false;
  }

  dispose(): void {
    this.resolveAll(null);
    this.worker?.terminate();
    this.worker = null;
  }
}
