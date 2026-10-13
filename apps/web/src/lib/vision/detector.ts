import { FilesetResolver, ObjectDetector } from '@mediapipe/tasks-vision';
import type { Detection } from '../../types';

/**
 * Tier-1 detector: MediaPipe EfficientDet-Lite0 (COCO 80 classes).
 * Replaces TFJS COCO-SSD: faster on mobile GPU, smaller, no TFJS bundle.
 * Same interface: loadDetector() / detectFrame(model, source) / disposeDetector() / getBackend().
 * Model file: public/models/efficientdet-lite0.tflite (downloaded by scripts/setup-assets.mjs).
 * WASM: /tasks-vision/wasm (copied by setup-assets) or CDN fallback.
 */

export type DetectorModel = ObjectDetector;

let modelPromise: Promise<ObjectDetector> | null = null;
let activeBackend = 'unknown';

export function getBackend(): string { return activeBackend; }

export async function loadDetector(): Promise<ObjectDetector> {
  if (modelPromise) return modelPromise;
  modelPromise = (async () => {
    let vision;
    try {
      vision = await FilesetResolver.forVisionTasks('/tasks-vision/wasm');
      activeBackend = 'mediapipe-gpu';
    } catch {
      vision = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20/wasm');
      activeBackend = 'mediapipe-gpu-cdn';
    }
    const detector = await ObjectDetector.createFromOptions(vision, {
      baseOptions: { modelAssetPath: '/models/efficientdet-lite0.tflite', delegate: 'GPU' },
      scoreThreshold: 0.5,
      maxResults: 12,
    });
    // Warmup on blank canvas so first real frame is fast.
    try {
      const warmup = document.createElement('canvas');
      warmup.width = 320; warmup.height = 240;
      const ctx = warmup.getContext('2d');
      if (ctx) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 320, 240); detector.detect(warmup); }
    } catch { /* warmup best-effort */ }
    return detector;
  })();
  try { return await modelPromise; } catch (e) { modelPromise = null; throw e; }
}

export interface DetectOptions { maxBoxes?: number; minScore?: number; }

export async function detectFrame(
  model: ObjectDetector,
  source: HTMLVideoElement | HTMLCanvasElement,
  { maxBoxes = 12, minScore = 0.5 }: DetectOptions = {},
): Promise<Detection[]> {
  const out = model.detect(source as HTMLVideoElement);
  const dets = (out?.detections ?? []).slice(0, maxBoxes);
  const result: Detection[] = [];
  for (const d of dets) {
    const cat = d.categories?.[0];
    if (!cat || cat.score < minScore) continue;
    const b = d.boundingBox;
    if (!b) continue;
    result.push({ label: cat.categoryName || 'object', score: cat.score, bbox: [b.originX, b.originY, b.width, b.height] });
  }
  return result;
}

export function disposeDetector(): void { modelPromise = null; }
