/**
 * Prepares the large binary assets the depth layer needs.
 *
 * Two jobs:
 *  1. Copy the ONNX Runtime WASM files out of node_modules so they are served
 *     from our own origin. Loading them from a CDN would mean the offline
 *     safety layer stops working the moment the network does.
 *  2. Download the Depth Anything V2 Small model if it is not already present.
 *     It is 26 MB, so it is gitignored rather than committed.
 *
 * Runs automatically before `dev` and `build`. Safe to re-run: it skips work
 * that is already done.
 */

import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '..');
const repoRoot = resolve(webRoot, '../..');

const ORT_DIST = join(repoRoot, 'node_modules/onnxruntime-web/dist');
const ORT_TARGET = join(webRoot, 'public/ort');

/**
 * Only the plain SIMD+threads build is copied. The jsep, jspi and asyncify
 * variants exist for WebGPU and stack-switching backends we do not use, and
 * together they are roughly 70 MB.
 */
const ORT_FILES = [
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
];

const MODEL_DIR = join(webRoot, 'public/models');
const MODEL_FILE = join(MODEL_DIR, 'depth-anything-v2-small.onnx');
const MODEL_URL =
  'https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model_quantized.onnx';

/** Roughly the expected size; a truncated download should not be trusted. */
const MODEL_MIN_BYTES = 20 * 1024 * 1024;

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function copyOrtRuntime() {
  if (!(await exists(ORT_DIST))) {
    console.warn('[assets] onnxruntime-web not installed; skipping WASM copy.');
    return;
  }

  await mkdir(ORT_TARGET, { recursive: true });
  const available = new Set(await readdir(ORT_DIST));
  const files = ORT_FILES.filter((name) => available.has(name));

  let copied = 0;
  for (const name of files) {
    const from = join(ORT_DIST, name);
    const to = join(ORT_TARGET, name);
    const [src, dest] = await Promise.all([
      stat(from),
      exists(to).then((ok) => (ok ? stat(to) : null)),
    ]);
    if (dest && dest.size === src.size) continue;
    await copyFile(from, to);
    copied += 1;
  }

  console.log(
    `[assets] ONNX Runtime: ${files.length} files present` +
      (copied ? ` (${copied} updated)` : ' (up to date)'),
  );
}

async function fetchDepthModel() {
  if (await exists(MODEL_FILE)) {
    const info = await stat(MODEL_FILE);
    if (info.size >= MODEL_MIN_BYTES) {
      console.log(
        `[assets] Depth model present (${(info.size / 1048576).toFixed(1)} MB).`,
      );
      return;
    }
    console.warn('[assets] Depth model looks truncated; downloading again.');
  }

  await mkdir(MODEL_DIR, { recursive: true });
  console.log('[assets] Downloading depth model (~26 MB), one time only…');

  try {
    const response = await fetch(MODEL_URL);
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`);
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(MODEL_FILE));
    const info = await stat(MODEL_FILE);
    console.log(`[assets] Depth model saved (${(info.size / 1048576).toFixed(1)} MB).`);
  } catch (error) {
    // Not fatal: the app detects the missing model and runs without the
    // terrain layer rather than failing to start.
    console.warn(
      `[assets] Could not download the depth model (${error.message}).\n` +
        '          Terrain detection will stay off until it is available.',
    );
  }
}

await copyOrtRuntime();
await fetchDepthModel();
