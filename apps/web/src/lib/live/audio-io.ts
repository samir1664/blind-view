import { base64ToFloat32, downsample, floatToPcm16Base64, rms } from './pcm';

/**
 * Microphone in and speaker out for the Live voice link.
 *
 * The SDK helper (startAudioConversation) only offers stop(); a safety app has
 * to cut the assistant mid-word when a hazard appears or the user speaks, so
 * playback is a queue we own and can flush instantly.
 */

const INPUT_RATE = 16000;
const OUTPUT_RATE = 24000;
/** ~100 ms per chunk sent upstream. */
const CHUNK_SECONDS = 0.1;
/**
 * While the assistant is talking, the phone's own speaker leaks into the mic.
 * Echo cancellation removes most of it; this floor stops the remainder from
 * interrupting the assistant, while a user speaking up still gets through.
 */
const BARGE_IN_RMS = 0.045;

const MIC_WORKLET = `
class MicTap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor('mic-tap', MicTap);
`;

let context: AudioContext | null = null;

function audioContext(): AudioContext {
  if (!context) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    context = new Ctor();
  }
  return context;
}

/** Must be called inside the user's tap, or iOS keeps the context suspended. */
export async function unlockLiveAudio(): Promise<void> {
  const ctx = audioContext();
  if (ctx.state !== 'running') await ctx.resume();
}

export interface Player {
  enqueue(b64Pcm24k: string): void;
  /** Stop everything queued or playing, immediately. */
  flush(): void;
  setGain(value: number): void;
  isPlaying(): boolean;
  /** Called when the queue drains after having played something. */
  onIdle: (() => void) | null;
}

export async function createPlayer(): Promise<Player> {
  const ctx = audioContext();
  const gain = ctx.createGain();
  gain.connect(ctx.destination);

  // Load the AudioWorklet processor module for low‑latency PCM playback.
  await ctx.audioWorklet.addModule(new URL('./audioWorkletProcessor', import.meta.url).toString());
  const node = new AudioWorkletNode(ctx, 'pcm-player');
  node.connect(gain);

  // Forward idle notifications from the worklet to the Player.
  let idleCallback: (() => void) | null = null;
  node.port.onmessage = (event: MessageEvent<any>) => {
    if (event.data?.idle) {
      idleCallback?.();
    }
  };

  // Real playing state: estimated end time of queued audio. Enqueue extends it,
  // flush/idle clears it. Scheduler uses isPlaying() to skip ticks while speaking.
  let playingUntil = 0;

  const player: Player = {
    onIdle: null,
    enqueue(b64) {
      const samples = base64ToFloat32(b64);
      if (samples.length === 0) return;
      // Send the Float32Array directly to the worklet for immediate playback.
      node.port.postMessage(samples);
      const durMs = (samples.length / OUTPUT_RATE) * 1000;
      playingUntil = Math.max(playingUntil, Date.now() + durMs);
    },
    flush() {
      // Clear any buffered PCM in the worklet.
      node.port.postMessage({ clear: true });
      playingUntil = 0;
    },
    setGain(value) {
      gain.gain.setTargetAtTime(Math.max(0, Math.min(1, value)), ctx.currentTime, 0.02);
    },
    isPlaying() {
      return Date.now() < playingUntil;
    },
  };

  // Wire the idle callback to the player's onIdle property.
  idleCallback = () => { playingUntil = 0; player.onIdle?.(); };

  return player;
}

export interface Mic {
  stop(): void;
}

/**
 * Capture the microphone and deliver ~100 ms base64 PCM16 chunks at 16 kHz.
 * `isAssistantSpeaking` lets the caller apply the barge-in floor.
 */
export async function startMic(
  onChunk: (b64Pcm16k: string) => void,
  isAssistantSpeaking: () => boolean,
): Promise<Mic> {
  const ctx = audioContext();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });

  const url = URL.createObjectURL(new Blob([MIC_WORKLET], { type: 'application/javascript' }));
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }

  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'mic-tap');
  // Keep the graph pulling without making the mic audible.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  source.connect(node);
  node.connect(sink);
  sink.connect(ctx.destination);

  const perChunk = Math.round(ctx.sampleRate * CHUNK_SECONDS);
  let pending: Float32Array[] = [];
  let pendingLength = 0;

  node.port.onmessage = (event: MessageEvent<Float32Array>) => {
    pending.push(event.data);
    pendingLength += event.data.length;
    if (pendingLength < perChunk) return;

    const merged = new Float32Array(pendingLength);
    let offset = 0;
    for (const part of pending) {
      merged.set(part, offset);
      offset += part.length;
    }
    pending = [];
    pendingLength = 0;

    if (isAssistantSpeaking() && rms(merged) < BARGE_IN_RMS) return;
    onChunk(floatToPcm16Base64(downsample(merged, ctx.sampleRate, INPUT_RATE)));
  };

  return {
    stop() {
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      sink.disconnect();
      for (const track of stream.getTracks()) track.stop();
    },
  };
}
