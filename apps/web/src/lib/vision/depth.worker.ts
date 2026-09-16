/// <reference lib="webworker" />

// The WASM-only entry point on purpose. The default export pulls in the WebGPU
// and JSPI builds too, which add ~70 MB of .wasm we never execute.
import * as ort from 'onnxruntime-web/wasm';

/**
 * Depth estimation worker.
 *
 * This runs in a worker for one non-negotiable reason: inference measured
 * 335 ms at 196x196 on a modern laptop. On the main thread that would stall
 * the 8 fps hazard loop for a third of a second at a time — the exact moments
 * when a car is closing are when you least want the detector frozen.
 *
 * The model is Depth Anything V2 Small, which predicts *relative inverse
 * depth*: larger values are nearer. It is not metric, and no amount of
 * post-processing makes it metric. We therefore use it only for comparisons
 * within a single frame — which lane is more open, where the ground breaks —
 * and never to state a distance in metres.
 */

/**
 * Serve the runtime from our own origin so the offline layer stays offline.
 *
 * This must be a fully-qualified URL, not "/ort/". ONNX Runtime loads its glue
 * code with a dynamic import(), and Vite intercepts bare absolute paths and
 * refuses them with "this file is in /public and should not be imported from
 * source code". An absolute URL is treated as external and passes through.
 */
ort.env.wasm.wasmPaths = new URL('/ort/', self.location.origin).href;
ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';

const MODEL_URL = '/models/depth-anything-v2-small.onnx';

/** ImageNet normalisation, as used by Depth Anything's preprocessing. */
const MEAN = [0.485, 0.456, 0.406] as const;
const STD = [0.229, 0.224, 0.225] as const;

let session: ort.InferenceSession | null = null;
let loading: Promise<ort.InferenceSession> | null = null;

export interface DepthRequest {
  type: 'estimate';
  id: number;
  /** RGBA pixels of a square, pre-resized frame. */
  pixels: ArrayBuffer;
  size: number;
}

export type DepthWorkerMessage =
  | { type: 'ready' }
  | { type: 'error'; message: string }
  | {
      type: 'result';
      id: number;
      depth: ArrayBuffer;
      size: number;
      inferenceMs: number;
    };

async function getSession(): Promise<ort.InferenceSession> {
  if (session) return session;
  if (!loading) {
    loading = ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
  }
  session = await loading;
  return session;
}

/** RGBA bytes → normalised float32 NCHW, which is what the model expects. */
function toTensor(pixels: Uint8ClampedArray, size: number): ort.Tensor {
  const plane = size * size;
  const data = new Float32Array(3 * plane);

  for (let i = 0, p = 0; i < plane; i += 1, p += 4) {
    data[i] = ((pixels[p] ?? 0) / 255 - MEAN[0]) / STD[0];
    data[plane + i] = ((pixels[p + 1] ?? 0) / 255 - MEAN[1]) / STD[1];
    data[2 * plane + i] = ((pixels[p + 2] ?? 0) / 255 - MEAN[2]) / STD[2];
  }

  return new ort.Tensor('float32', data, [1, 3, size, size]);
}

self.onmessage = async (event: MessageEvent<DepthRequest>) => {
  const request = event.data;
  if (request.type !== 'estimate') return;

  try {
    const active = await getSession();
    const pixels = new Uint8ClampedArray(request.pixels);
    const input = toTensor(pixels, request.size);

    const startedAt = performance.now();
    const output = await active.run({ [active.inputNames[0]!]: input });
    const inferenceMs = performance.now() - startedAt;

    const tensor = output[active.outputNames[0]!];
    if (!tensor) throw new Error('Model returned no depth output.');

    // Copy into a fresh buffer so it can be transferred rather than cloned.
    const depth = Float32Array.from(tensor.data as Float32Array);

    const message: DepthWorkerMessage = {
      type: 'result',
      id: request.id,
      depth: depth.buffer,
      size: request.size,
      inferenceMs,
    };
    (self as unknown as Worker).postMessage(message, [depth.buffer]);
  } catch (error) {
    const message: DepthWorkerMessage = {
      type: 'error',
      message: (error as Error).message ?? 'Depth estimation failed.',
    };
    (self as unknown as Worker).postMessage(message);
  }
};

(self as unknown as Worker).postMessage({ type: 'ready' } satisfies DepthWorkerMessage);
