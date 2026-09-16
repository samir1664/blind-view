import * as tf from '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-converter';
import '@tensorflow/tfjs-backend-webgl';
import '@tensorflow/tfjs-backend-cpu';
import * as cocoSsd from '@tensorflow-models/coco-ssd';

import type { Detection } from '../../types';

/**
 * Tier-1 detector: runs entirely on the device, costs nothing, works offline.
 *
 * We use COCO-SSD with the `lite_mobilenet_v2` base rather than a YOLO ONNX
 * export for one practical reason: the weights are hosted and versioned by
 * Google, so there is no model file to vendor, host, or keep from 404-ing.
 * It knows the 80 COCO classes, which happens to include almost everything
 * that can hurt a pedestrian — car, bus, truck, motorcycle, bicycle, person,
 * dog, traffic light, stop sign, bench, fire hydrant.
 *
 * Backend choice is WebGL, not WebGPU: WebGL is the only GPU path that works
 * on iOS Safari today, and it is fast enough here. Revisit WebGPU once Safari
 * ships it broadly.
 */

let modelPromise: Promise<cocoSsd.ObjectDetection> | null = null;
let activeBackend = 'unknown';

export function getBackend(): string {
  return activeBackend;
}

export async function loadDetector(): Promise<cocoSsd.ObjectDetection> {
  if (modelPromise) return modelPromise;

  modelPromise = (async () => {
    try {
      await tf.setBackend('webgl');
      await tf.ready();
    } catch {
      await tf.setBackend('cpu');
      await tf.ready();
    }
    activeBackend = tf.getBackend();

    const model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });

    // First inference compiles shaders and is 10–20× slower than the rest.
    // Burn it on a blank canvas so the user's first real frame is fast.
    const warmup = document.createElement('canvas');
    warmup.width = 320;
    warmup.height = 240;
    const ctx = warmup.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, warmup.width, warmup.height);
      await model.detect(warmup);
    }

    return model;
  })();

  try {
    return await modelPromise;
  } catch (error) {
    // Allow a retry on the next call instead of caching the failure forever.
    modelPromise = null;
    throw error;
  }
}

export interface DetectOptions {
  maxBoxes?: number;
  minScore?: number;
}

export async function detectFrame(
  model: cocoSsd.ObjectDetection,
  source: HTMLVideoElement | HTMLCanvasElement,
  { maxBoxes = 12, minScore = 0.5 }: DetectOptions = {},
): Promise<Detection[]> {
  const predictions = await model.detect(source, maxBoxes, minScore);

  return predictions.map((prediction) => ({
    label: prediction.class,
    score: prediction.score,
    bbox: [
      prediction.bbox[0],
      prediction.bbox[1],
      prediction.bbox[2],
      prediction.bbox[3],
    ] as [number, number, number, number],
  }));
}

export function disposeDetector(): void {
  modelPromise = null;
}
