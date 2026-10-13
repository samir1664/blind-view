// AudioWorkletProcessor for low‑latency PCM playback.
// Receives Float32Array PCM chunks (24 kHz, mono) via the node's port
// and streams them to the output buffer. When the queue empties it posts
// an `{ idle: true }` message so the Player can emit its `onIdle` callback.

// Module-local worklet globals: the worklet runs in its own scope, and the
// app tsconfig does not provide AudioWorkletProcessor/registerProcessor
// types. Declared here (not globally) so there is no conflict with lib.dom.
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}

declare function registerProcessor(name: string, processorCtor: new (options?: unknown) => AudioWorkletProcessor): void;

class PCMPlayer extends AudioWorkletProcessor {
  // Queue of pending Float32Array sample blocks.
  private pending: Float32Array[] = [];

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<any>) => {
      const data = event.data;
      if (data && typeof data === 'object' && data.clear) {
        // Clear any buffered audio.
        this.pending = [];
      } else if (data instanceof Float32Array) {
        // Append new PCM chunk.
        this.pending.push(data);
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][], _parameters: Record<string, Float32Array>) {
    const output = outputs[0]?.[0]; // mono output
    if (!output) return true;
    let offset = 0;

    while (offset < output.length && this.pending.length > 0) {
      const chunk = this.pending[0];
      if (!chunk) break;
      const needed = output.length - offset;
      if (chunk.length <= needed) {
        output.set(chunk, offset);
        offset += chunk.length;
        this.pending.shift(); // remove consumed chunk
      } else {
        // Take a slice of the chunk and keep the remainder.
        output.set(chunk.subarray(0, needed), offset);
        this.pending[0] = chunk.subarray(needed);
        offset = output.length;
      }
    }

    // Fill the rest with silence.
    if (offset < output.length) {
      output.fill(0, offset);
    }

    // Notify idle when nothing remains.
    if (this.pending.length === 0) {
      this.port.postMessage({ idle: true });
    }

    return true; // keep processor alive
  }
}

registerProcessor('pcm-player', PCMPlayer);

export {};
