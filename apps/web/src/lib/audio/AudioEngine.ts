import {
  audioContextState,
  playEarcon,
  setEarconVolume,
  unlockAudio,
} from './earcons';
import type { EarconType } from './earcons';
import type { TranscriptSource } from '../../types';

/**
 * Voices known to be clear and suitable for continuous listening. Tried in
 * order when picking automatically.
 */
const PREFERRED_VOICES = [
  'Samantha',
  'Alex',
  'Daniel',
  'Karen',
  'Serena',
  'Moira',
  'Tessa',
  'Fiona',
  'Rishi',
  'Google US English',
  'Microsoft Aria',
  'Microsoft Zira',
];

/**
 * macOS ships a set of joke voices that are perfectly functional and totally
 * unusable for this. A blind user must never be auto-assigned "Bells" to have
 * traffic hazards read to them, so these are excluded from automatic choice.
 * They remain selectable by hand in settings.
 */
const NOVELTY_VOICES =
  /^(albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|hysterical|jester|junior|organ|princess|ralph|superstar|trinoids|whisper|wobble|zarvox|fred|kathy|agnes|victoria|bruce|grandma|grandpa|rocko|shelley|sandy|eddy|flo|reed|rina)\b/i;

function isUsableVoice(voice: SpeechSynthesisVoice): boolean {
  return !NOVELTY_VOICES.test(voice.name);
}

/** Result of exercising both audio subsystems, for when nothing is audible. */
export interface AudioDiagnostics {
  speechSupported: boolean;
  voiceCount: number;
  selectedVoice: string;
  /** 'running' means WebAudio is genuinely producing output. */
  audioContextState: string;
  /** Embedded webviews often expose the speech API but cannot play it. */
  embeddedBrowser: boolean;
  speechStarted: boolean;
  speechEnded: boolean;
  /** Set when a fallback voice worked, so the UI can persist the choice. */
  workingVoiceUri: string | null;
  /** Per-voice outcome, so a failure can be diagnosed rather than guessed at. */
  voicesTried: string[];
  error: string | null;
  summary: string;
}

function summarise(report: AudioDiagnostics): string {
  if (report.speechStarted && report.speechEnded) {
    return report.audioContextState === 'running'
      ? `Working — spoken with "${report.selectedVoice}". If you heard nothing, the sound is going to another output device, or this tab is muted.`
      : `Speech played with "${report.selectedVoice}", but the beep could not start. Check the tab is not muted.`;
  }
  if (report.speechStarted) {
    return `Started with "${report.selectedVoice}" but never finished. The voice may still be downloading.`;
  }
  if (report.error) {
    return `The speech engine reported an error: ${report.error}.`;
  }
  if (report.embeddedBrowser) {
    return 'This looks like an embedded browser (such as the editor preview pane). Those expose voices but usually cannot play them. Open http://localhost:5173 in Safari or Chrome instead.';
  }
  /**
   * Voices are installed but not one of them produced a single event. That is
   * a broken browser speech engine, not a missing voice — so do not send the
   * user off to download voices they already have.
   */
  if (report.voiceCount > 0) {
    return `None of the ${report.voiceCount} installed voices produced any audio, and the speech engine reported no error at all. That points at the browser rather than your voices. Open Blind View in Safari, or fully quit and reopen this browser — Chrome's speech engine can stop responding until it is restarted. The warning tones will keep working in the meantime.`;
  }
  return 'No voices are available to this browser. On macOS open System Settings, Accessibility, Spoken Content, and download a System Voice.';
}

/**
 * Speech priority. Lower number wins and will interrupt anything higher.
 *
 * The whole point: a leisurely scene description must be cut off mid-word the
 * instant a car is detected. Politeness kills people.
 */
export const Priority = {
  HAZARD: 0,
  ALERT: 1,
  NARRATION: 2,
  INFO: 3,
} as const;

export type PriorityLevel = (typeof Priority)[keyof typeof Priority];

export interface SpeakRequest {
  text: string;
  priority: PriorityLevel;
  source: TranscriptSource;
  earcon?: EarconType;
  /** -1 left … 1 right. Applies to the earcon only; TTS cannot be panned. */
  pan?: number;
  /** Suppress repeats of the same key. */
  dedupeKey?: string;
  /** How long to suppress repeats of `dedupeKey`. Default 4000 ms. */
  cooldownMs?: number;
  /** Drop from the queue if not spoken within this window. Default 8000 ms. */
  ttlMs?: number;
}

interface QueueItem extends SpeakRequest {
  id: number;
  queuedAt: number;
}

/** Never let low-priority chatter pile up while the user is walking. */
const MAX_QUEUE = 6;

/**
 * How long to wait for `onstart` before concluding the speech engine is
 * wedged. Generous, because a voice being loaded for the first time can take
 * a moment to begin.
 */
const ENGINE_START_TIMEOUT_MS = 4000;

/**
 * Extra margin allowed after a phrase should have finished, for engines that
 * start speaking but never report completion. Only ever advances the queue —
 * it never cancels audio that may still be playing.
 */
const LOST_COMPLETION_GRACE_MS = 8000;

/**
 * How many utterances may be accepted-but-never-spoken before the browser's
 * speech engine is declared dead.
 *
 * Chrome on macOS can reach a state where `speak()` is accepted, `speaking`
 * flips to true, and no `start`, `end` or `error` event ever fires. The OS
 * voices are fine (`say` works, Safari works) but nothing is audible and
 * nothing reports a failure. One silent utterance can just be a voice loading
 * for the first time; three in a row is a broken engine, and a blind user must
 * be told rather than left in silence.
 */
const SILENT_STREAK_LIMIT = 3;

export class AudioEngine {
  private queue: QueueItem[] = [];
  private current: QueueItem | null = null;
  private lastSpokenAt = new Map<string, number>();
  private seq = 0;
  private cancelledAt = 0;
  private unlocked = false;
  private watchdog: number | null = null;
  private utteranceTimer: number | null = null;

  private voice: SpeechSynthesisVoice | null = null;
  private rate = 1.1;
  private pitch = 1;
  private volume = 1;
  private earconsEnabled = true;
  private muted = false;

  /** Consecutive utterances the engine accepted but never began speaking. */
  private silentStreak = 0;
  private speechDead = false;

  /** Fires whenever an utterance actually begins, for the on-screen transcript. */
  onSpeak: ((item: SpeakRequest) => void) | null = null;

  /**
   * Fires once when the browser's speech engine is judged non-functional, so
   * the UI can say so out loud in text. Silence is the one failure mode this
   * app must never present without explanation.
   */
  onSpeechUnavailable: ((reason: string) => void) | null = null;

  /** True once the engine has repeatedly accepted speech without speaking. */
  get isSpeechDead(): boolean {
    return this.speechDead;
  }

  /**
   * Records whether an utterance actually produced audio, and raises the alarm
   * once enough of them have silently vanished.
   */
  private noteSpeechOutcome(started: boolean): void {
    if (started) {
      this.silentStreak = 0;
      this.speechDead = false;
      return;
    }

    this.silentStreak += 1;
    if (this.speechDead || this.silentStreak < SILENT_STREAK_LIMIT) return;

    this.speechDead = true;
    const count = this.getVoices().length;
    this.onSpeechUnavailable?.(
      `Speech is not working in this browser. ${count} voices are installed but the speech engine never starts, so only the warning tones will play. Open Blind View in Safari, or fully quit and reopen this browser.`,
    );
  }

  private get synth(): SpeechSynthesis | null {
    return typeof window !== 'undefined' && 'speechSynthesis' in window
      ? window.speechSynthesis
      : null;
  }

  get isSupported(): boolean {
    return this.synth !== null;
  }

  /** Call from a user gesture. Unlocks both WebAudio and speech on iOS. */
  async unlock(): Promise<void> {
    if (this.unlocked) return;
    this.unlocked = true;

    /**
     * Both the AudioContext and the speech engine need to be started from
     * inside the user's tap. Browsers consume that permission the moment the
     * call stack yields, so BOTH must be *initiated* synchronously here —
     * awaiting the AudioContext before speaking the primer would forfeit the
     * gesture and leave speech permanently silent on Safari.
     */
    const audioReady = unlockAudio();

    const synth = this.synth;
    if (synth) {
      // Clear anything wedged in the native queue from a previous session.
      // Recording the time matters: Chrome silently drops an utterance issued
      // too soon after a cancel, which would mute the first announcement.
      this.cancelledAt = Date.now();
      synth.cancel();

      /**
       * A near-silent utterance inside the gesture is what actually grants
       * permission on iOS Safari; without it later speak() calls do nothing.
       *
       * The text must NOT be blank or whitespace. Chrome never fires start or
       * end for an empty utterance and leaves it pending forever — and since
       * the speech queue is FIFO, one stuck primer silently blocks every
       * utterance for the rest of the session.
       */
      const primer = new SpeechSynthesisUtterance('ok');
      primer.volume = 0;
      primer.rate = 2;
      synth.speak(primer);
      this.startWatchdog();
    }

    await audioReady;
  }

  getVoices(): SpeechSynthesisVoice[] {
    return this.synth?.getVoices() ?? [];
  }

  setVoiceByUri(uri: string | null): void {
    if (!uri) {
      this.voice = null;
      return;
    }
    this.voice = this.getVoices().find((v) => v.voiceURI === uri) ?? null;
  }

  /**
   * Always hand the engine a concrete voice.
   *
   * Leaving `utterance.voice` null and `lang` unset means "use the system
   * default" — but Chrome on macOS then frequently fails to resolve anything
   * and drops the utterance without firing a single event or error. Picking a
   * voice explicitly is the difference between speech and silence.
   *
   * Local voices are strongly preferred: network-backed ones fail quietly when
   * offline, which is exactly when a blind user still needs hazard warnings.
   */
  private resolveVoice(): SpeechSynthesisVoice | null {
    if (this.voice) return this.voice;

    const voices = this.getVoices().filter(isUsableVoice);
    if (voices.length === 0) return this.getVoices()[0] ?? null;

    const uiLang =
      typeof navigator !== 'undefined' ? navigator.language : 'en-US';
    const base = uiLang.split('-')[0] ?? 'en';

    const byName = PREFERRED_VOICES.map((name) =>
      voices.find((v) => v.name.startsWith(name)),
    ).find(Boolean);

    return (
      byName ??
      voices.find((v) => v.default && v.localService) ??
      voices.find((v) => v.localService && v.lang.startsWith(base)) ??
      voices.find((v) => v.localService && v.lang.startsWith('en')) ??
      voices.find((v) => v.default) ??
      voices.find((v) => v.lang.startsWith(base)) ??
      voices.find((v) => v.lang.startsWith('en')) ??
      voices[0] ??
      null
    );
  }

  /** Applies voice, language and prosody to an utterance about to be spoken. */
  private configure(utterance: SpeechSynthesisUtterance): string {
    const voice = this.resolveVoice();
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }
    utterance.rate = this.rate;
    utterance.pitch = this.pitch;
    utterance.volume = this.volume;
    return voice?.name ?? 'none available';
  }

  setRate(rate: number): void {
    this.rate = Math.max(0.5, Math.min(2.5, rate));
  }

  setPitch(pitch: number): void {
    this.pitch = Math.max(0.5, Math.min(2, pitch));
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    setEarconVolume(this.volume);
  }

  setEarconsEnabled(enabled: boolean): void {
    this.earconsEnabled = enabled;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.stopAll();
  }

  /**
   * Speaks a test phrase directly, bypassing the queue, and reports what the
   * speech engine actually did.
   *
   * "I hear nothing" has several very different causes — a muted tab, a system
   * voice that was never downloaded, an embedded webview with no audio backend,
   * an engine that accepts utterances and silently drops them. They are
   * indistinguishable by ear, so the engine is asked to account for itself.
   */
  async diagnose(): Promise<AudioDiagnostics> {
    await this.unlock();

    const synth = this.synth;
    const voices = this.getVoices();

    // Electron-based embedded browsers (VS Code's Simple Browser among them)
    // expose the speech API but frequently have no audio backend behind it.
    const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
    const embedded = /Electron|VSCode|Code\//i.test(ua);

    const report: AudioDiagnostics = {
      speechSupported: synth !== null,
      voiceCount: voices.length,
      selectedVoice: this.voice?.name ?? 'system default',
      audioContextState: audioContextState(),
      embeddedBrowser: embedded,
      speechStarted: false,
      speechEnded: false,
      workingVoiceUri: null,
      voicesTried: [],
      error: null,
      summary: '',
    };

    // WebAudio and speech synthesis are independent subsystems. Exercising
    // both tells us which half is broken.
    playEarcon('hazard', -0.7);
    report.audioContextState = audioContextState();

    if (!synth) {
      report.summary = 'This browser has no speech engine at all.';
      return report;
    }
    if (voices.length === 0) {
      report.summary = 'No voices are installed. Add one in your OS settings.';
      return report;
    }

    synth.cancel();
    this.cancelledAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 120));

    /**
     * Try the resolved voice, then fall back through other installed local
     * voices. macOS lists many voices that were never actually downloaded;
     * they accept an utterance and never speak. Rather than telling the user
     * to hunt through 199 entries by hand, find one that works and keep it.
     */
    const attempts: Array<SpeechSynthesisVoice | null> = [this.resolveVoice()];

    // Preferred, intelligible voices first; never a novelty voice. Offline
    // voices are ordered ahead of cloud ones, which fail silently without a
    // network and are useless to someone walking outdoors.
    const preferred = PREFERRED_VOICES.map((name) =>
      voices.find((v) => v.name.startsWith(name) && isUsableVoice(v)),
    ).filter((v): v is SpeechSynthesisVoice => Boolean(v));

    for (const match of [
      ...preferred.filter((v) => v.localService),
      ...preferred.filter((v) => !v.localService),
    ]) {
      if (attempts.some((v) => v?.voiceURI === match.voiceURI)) continue;
      attempts.push(match);
    }

    for (const voice of voices) {
      if (attempts.length >= 5) break;
      if (!voice.localService || !isUsableVoice(voice)) continue;
      if (!voice.lang.startsWith('en')) continue;
      if (attempts.some((v) => v?.voiceURI === voice.voiceURI)) continue;
      attempts.push(voice);
    }

    for (const voice of attempts) {
      // Clear the queue before every attempt. Without this, a first utterance
      // that sticks leaves all the others queued behind it, so they report
      // failure regardless of whether that voice actually works — which makes
      // the whole fallback meaningless.
      synth.cancel();
      this.cancelledAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 150));

      const outcome = await this.trySpeak(synth, voice);
      report.selectedVoice = voice?.name ?? 'system default';
      report.speechStarted = outcome.started;
      report.speechEnded = outcome.ended;
      report.error = outcome.error;
      report.voicesTried.push(
        `${voice?.name ?? 'default'}: ${
          outcome.started ? 'spoke' : (outcome.error ?? 'no response')
        }`,
      );

      if (outcome.started) {
        // Remember what worked, so normal narration uses it too.
        if (voice) {
          this.voice = voice;
          report.workingVoiceUri = voice.voiceURI;
        }
        this.silentStreak = 0;
        this.speechDead = false;
        break;
      }
    }

    // Every installed voice was tried and none made a sound. Record that, so
    // the running session reports silence instead of quietly producing none.
    if (!report.speechStarted) {
      this.silentStreak = SILENT_STREAK_LIMIT;
      this.speechDead = true;
    }

    report.summary = summarise(report);
    return report;
  }

  private trySpeak(
    synth: SpeechSynthesis,
    voice: SpeechSynthesisVoice | null,
  ): Promise<{ started: boolean; ended: boolean; error: string | null }> {
    return new Promise((resolve) => {
      const utterance = new SpeechSynthesisUtterance('Car, close, on your left.');
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      }
      utterance.rate = this.rate;
      utterance.pitch = this.pitch;
      utterance.volume = Math.max(0.2, this.volume);

      let started = false;
      let ended = false;
      let error: string | null = null;
      let settled = false;
      let timer = 0;

      const done = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve({ started, ended, error });
      };

      utterance.onstart = () => {
        started = true;
        // It is speaking, so allow time to finish rather than cutting it off.
        window.clearTimeout(timer);
        timer = window.setTimeout(done, 7000);
      };
      utterance.onend = () => {
        ended = true;
        done();
      };
      utterance.onerror = (event) => {
        error = event.error;
        done();
      };

      // A working voice fires `onstart` almost immediately. Anything slower
      // is not going to speak, and waiting makes the user sit through a long
      // test for nothing.
      timer = window.setTimeout(done, 2500);

      // `paused` is unreliable on macOS Chrome, so resume either side of the
      // call rather than trusting it.
      synth.resume();
      synth.speak(utterance);
      synth.resume();
    });
  }

  speak(request: SpeakRequest): void {
    const text = request.text.trim();
    if (!text || this.muted) return;

    const now = Date.now();

    if (request.dedupeKey) {
      const last = this.lastSpokenAt.get(request.dedupeKey) ?? 0;
      const cooldown = request.cooldownMs ?? 4000;
      if (now - last < cooldown) return;
      this.lastSpokenAt.set(request.dedupeKey, now);
    }

    const item: QueueItem = {
      ...request,
      text,
      id: ++this.seq,
      queuedAt: now,
    };

    // A new hazard outranks whatever is being said — cut it off immediately.
    if (this.current && item.priority < this.current.priority) {
      this.queue.unshift(item);
      this.hardStopCurrent();
      this.pump();
      return;
    }

    this.queue.push(item);
    this.queue.sort((a, b) => a.priority - b.priority || a.id - b.id);

    if (this.queue.length > MAX_QUEUE) {
      // Drop the least urgent, oldest items rather than the newest —
      // stale information is worse than no information.
      this.queue = this.queue.slice(0, MAX_QUEUE);
    }

    this.pump();
  }

  /** Clears everything and silences output now. */
  stopAll(): void {
    this.queue = [];
    this.hardStopCurrent();
  }

  /** Forgets dedupe history, e.g. when restarting a session. */
  resetDedupe(): void {
    this.lastSpokenAt.clear();
  }

  dispose(): void {
    this.stopAll();
    if (this.watchdog !== null) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  private hardStopCurrent(): void {
    this.current = null;
    if (this.utteranceTimer !== null) {
      clearTimeout(this.utteranceTimer);
      this.utteranceTimer = null;
    }
    const synth = this.synth;
    if (synth) {
      this.cancelledAt = Date.now();
      synth.cancel();
    }
  }

  private pump(): void {
    if (this.current || this.muted) return;

    const synth = this.synth;
    const now = Date.now();

    // Discard anything that has aged out while waiting.
    this.queue = this.queue.filter(
      (item) => now - item.queuedAt <= (item.ttlMs ?? 8000),
    );

    const next = this.queue.shift();
    if (!next) return;

    this.current = next;

    if (this.earconsEnabled && next.earcon) {
      playEarcon(next.earcon, next.pan ?? 0);
    }
    this.onSpeak?.(next);

    if (!synth) {
      // No speech synthesis available (rare). Earcon + transcript only.
      this.current = null;
      this.pump();
      return;
    }

    // Chrome and Safari both drop an utterance issued too soon after cancel().
    const sinceCancel = now - this.cancelledAt;
    const delay = Math.max(
      next.earcon && this.earconsEnabled ? 140 : 0,
      sinceCancel < 90 ? 90 - sinceCancel : 0,
    );

    const startId = next.id;
    window.setTimeout(() => {
      // Something more urgent arrived while we were waiting.
      if (this.current?.id !== startId) return;

      const utterance = new SpeechSynthesisUtterance(next.text);
      this.configure(utterance);

      // Chrome can leave the engine paused after a cancel; speaking into a
      // paused synthesizer produces silence with no error. `paused` is not
      // trustworthy on macOS Chrome — it reports false while the engine is
      // wedged — so resume unconditionally rather than only when it admits it.
      synth.resume();

      const finish = () => {
        if (this.utteranceTimer !== null) {
          clearTimeout(this.utteranceTimer);
          this.utteranceTimer = null;
        }
        if (this.current?.id === startId) {
          this.current = null;
          this.pump();
        }
      };

      let started = false;

      /**
       * Recovery, in two stages, driven by what the engine actually reports
       * rather than by guessing how long a phrase should take.
       *
       * An earlier version estimated the duration and cancelled when the
       * estimate expired. That cut off slower voices mid-sentence and left
       * the engine poisoned for everything after it. Never cancel speech that
       * might be playing.
       *
       * Stage 1 — did it even begin? `onstart` is the only reliable proof
       * that audio started. If it never fires and the engine also denies
       * speaking, the native queue is wedged: reset it and move on.
       *
       * Stage 2 — once started, only ever advance the queue, never cancel,
       * and only after a deliberately generous margin.
       */
      utterance.onstart = () => {
        started = true;
        this.noteSpeechOutcome(true);
        if (this.utteranceTimer !== null) {
          clearTimeout(this.utteranceTimer);
          this.utteranceTimer = null;
        }

        const words = next.text.split(/\s+/).length;
        const expectedMs = (words / (2.2 * this.rate)) * 1000;
        this.utteranceTimer = window.setTimeout(
          () => {
            if (this.current?.id === startId) finish();
          },
          expectedMs * 2 + LOST_COMPLETION_GRACE_MS,
        );
      };

      utterance.onend = finish;
      utterance.onerror = finish;

      this.utteranceTimer = window.setTimeout(() => {
        if (this.current?.id !== startId || started) return;

        // The engine may simply be slow to start a freshly loaded voice.
        // Only treat it as wedged if it also claims to be doing nothing.
        if (synth.speaking && !synth.paused) {
          this.utteranceTimer = window.setTimeout(() => {
            if (this.current?.id !== startId) return;
            // Still no `start` event after a generous wait: the engine took
            // the utterance, claims to be speaking, and produced nothing.
            if (!started) this.noteSpeechOutcome(false);
            finish();
          }, LOST_COMPLETION_GRACE_MS);
          return;
        }

        this.noteSpeechOutcome(false);

        try {
          this.cancelledAt = Date.now();
          synth.cancel();
        } catch {
          /* nothing useful to do */
        }
        finish();
      }, ENGINE_START_TIMEOUT_MS);

      try {
        synth.speak(utterance);
        // Some Chrome builds only dispatch the utterance after a nudge.
        synth.resume();
      } catch {
        this.noteSpeechOutcome(false);
        finish();
      }
    }, delay);
  }

  /**
   * Chrome silently pauses synthesis after roughly 15 seconds of speech and
   * never resumes on its own. Nudging it keeps long descriptions audible.
   */
  private startWatchdog(): void {
    if (this.watchdog !== null) return;
    this.watchdog = window.setInterval(() => {
      const synth = this.synth;
      if (synth?.speaking && !synth.paused) synth.resume();
    }, 5000);
  }
}

export const audioEngine = new AudioEngine();
