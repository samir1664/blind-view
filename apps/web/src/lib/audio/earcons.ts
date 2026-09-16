/**
 * Earcons — short non-speech audio cues.
 *
 * A 120 ms tone lands in the user's ear far faster than the word "car" can be
 * synthesised and spoken. Every hazard therefore fires an earcon first, panned
 * to the side the object is on, and the speech follows behind it. Over time
 * users learn the tones and stop needing the words at all.
 */

export type EarconType =
  | 'hazard'
  | 'alert'
  | 'info'
  | 'start'
  | 'stop'
  | 'listening'
  | 'error';

interface Tone {
  freq: number;
  /** Seconds from the start of the earcon. */
  at: number;
  dur: number;
  type: OscillatorType;
  gain: number;
  /** Optional glide target frequency. */
  slideTo?: number;
}

const PATTERNS: Record<EarconType, Tone[]> = {
  // Urgent, low, doubled — deliberately unpleasant so it cuts through.
  hazard: [
    { freq: 300, at: 0, dur: 0.09, type: 'square', gain: 0.5 },
    { freq: 300, at: 0.12, dur: 0.09, type: 'square', gain: 0.5 },
  ],
  alert: [{ freq: 520, at: 0, dur: 0.11, type: 'triangle', gain: 0.35 }],
  info: [{ freq: 880, at: 0, dur: 0.07, type: 'sine', gain: 0.2 }],
  start: [
    { freq: 440, at: 0, dur: 0.16, type: 'sine', gain: 0.3, slideTo: 720 },
  ],
  stop: [{ freq: 720, at: 0, dur: 0.16, type: 'sine', gain: 0.3, slideTo: 380 }],
  listening: [
    { freq: 660, at: 0, dur: 0.06, type: 'sine', gain: 0.25 },
    { freq: 990, at: 0.08, dur: 0.06, type: 'sine', gain: 0.25 },
  ],
  error: [{ freq: 180, at: 0, dur: 0.22, type: 'sawtooth', gain: 0.3 }],
};

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

function ensureContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);
  }
  return ctx;
}

/**
 * Must be called from inside a real user gesture (a tap). Browsers refuse to
 * start an AudioContext otherwise, and on iOS this is the only chance we get.
 */
export async function unlockAudio(): Promise<void> {
  const context = ensureContext();
  if (!context) return;
  if (context.state === 'suspended') {
    await context.resume().catch(() => undefined);
  }
}

export function setEarconVolume(volume: number): void {
  if (master) master.gain.value = Math.max(0, Math.min(1, volume));
}

/** 'running' means WebAudio is genuinely producing output. */
export function audioContextState(): string {
  if (!ctx) return 'not created';
  return ctx.state;
}

/**
 * @param pan -1 = full left, 0 = centre, 1 = full right.
 */
export function playEarcon(type: EarconType, pan = 0): void {
  const context = ensureContext();
  if (!context || !master) return;
  if (context.state === 'suspended') void context.resume().catch(() => undefined);

  const now = context.currentTime;

  let destination: AudioNode = master;
  if (typeof context.createStereoPanner === 'function') {
    const panner = context.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    panner.connect(master);
    destination = panner;
  }

  for (const tone of PATTERNS[type]) {
    const osc = context.createOscillator();
    const gain = context.createGain();

    osc.type = tone.type;
    const start = now + tone.at;
    const end = start + tone.dur;

    osc.frequency.setValueAtTime(tone.freq, start);
    if (tone.slideTo !== undefined) {
      osc.frequency.linearRampToValueAtTime(tone.slideTo, end);
    }

    // Short fades prevent the click you get from hard-gating a waveform.
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(tone.gain, start + 0.012);
    gain.gain.setValueAtTime(tone.gain, end - 0.02);
    gain.gain.linearRampToValueAtTime(0, end);

    osc.connect(gain);
    gain.connect(destination);
    osc.start(start);
    osc.stop(end + 0.02);
  }
}
