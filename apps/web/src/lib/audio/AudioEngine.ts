import {
  audioContextState,
  playEarcon,
  setEarconVolume,
  unlockAudio,
} from './earcons';
import type { EarconType } from './earcons';
import type { TranscriptSource } from '../../types';
import { authHeaders } from '../firebase';
import { pickVoice, resolveSpeechLanguage } from './voice';
import type { VoiceLike } from './voice';

/**
 * Language/voice root fix: the engine now resolves the system language,
 * picks a voice by language tag (never by macOS-only names alone), and
 * falls back to Cloud TTS audio when device speech is dead — so a judge
 * on a different device/language still hears speech instead of silence.
 */

/**
 * Interface for audio engine state to be emitted to subscribers
 */
export interface AudioEngineState {
  paused: boolean;
  speaking: boolean;
  volume: number;
  muted: boolean;
}

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
  /** 'system' = follow the device (navigator.language). Set from settings. */
  private language: string = 'system';
  /** Cloud TTS playback (MP3) when device speech is dead. */
  private cloudAudio: HTMLAudioElement | null = null;
  /** Item id already tried via cloud, so one utterance never speaks twice. */
  private cloudTriedFor = -1;
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

  /** Get the speech synthesis object */
  private get synth(): SpeechSynthesis | null {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      return window.speechSynthesis;
    }
    return null;
  }

  /** Current paused state */
  private _paused = false;

  /**
   * Get the current paused state
   */
  get isPaused(): boolean {
    return this._paused;
  }

  /** Get current volume level */
  getVolume(): number {
    return this.volume;
  }

  /** True while an utterance is in progress. */
  isSpeaking(): boolean {
    return this.current !== null;
  }

  /** Current muted state. */
  get isMuted(): boolean {
    return this.muted;
  }

  /** True after unlock() has run inside a user tap. */
  get isUnlocked(): boolean {
    return this.unlocked;
  }

  /**
   * Queue speech. Lower priority numbers win: a hazard jumps ahead of
   * narration and cuts off whatever is playing.
   */
  speak(request: SpeakRequest): void {
    const now = Date.now();
    if (request.dedupeKey) {
      const last = this.lastSpokenAt.get(request.dedupeKey);
      if (last !== undefined && now - last < (request.cooldownMs ?? 4000)) return;
      this.lastSpokenAt.set(request.dedupeKey, now);
    }
    const item: QueueItem = { ...request, id: ++this.seq, queuedAt: now };
    if (this.current && item.priority < this.current.priority) {
      this.cancelCurrent();
      this.current = null;
      this.queue.unshift(item);
    } else {
      this.queue.push(item);
      if (this.queue.length > MAX_QUEUE) {
        let dropIdx = 0;
        for (let i = 1; i < this.queue.length; i += 1) {
          if ((this.queue[i]?.priority ?? 0) > (this.queue[dropIdx]?.priority ?? 0)) dropIdx = i;
        }
        this.queue.splice(dropIdx, 1);
      }
    }
    this.pump();
  }

  /** Must be called inside the user's tap, or browsers refuse to speak. */
  async unlock(): Promise<void> {
    await unlockAudio();
    this.unlocked = true;
    // Voices populate async — wait for them so the first utterance is
    // not spoken with an empty list (silence on first Start).
    await this.waitForVoices();
    this.startWatchdog();
  }

  /** Drop everything queued or playing, immediately. */
  stopAll(): void {
    this.queue.length = 0;
    this.current = null;
    this.stopCloudAudio();
    this.cancelCurrent();
    if (this.utteranceTimer !== null) {
      clearTimeout(this.utteranceTimer);
      this.utteranceTimer = null;
    }
    this.dispatchStateChangeEvent();
  }

  /** Clear dedupe history, so repeats are allowed again. */
  resetDedupe(): void {
    this.lastSpokenAt.clear();
  }

  setRate(rate: number): void {
    this.rate = Math.max(0.5, Math.min(2.5, rate));
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    setEarconVolume(this.earconsEnabled ? this.volume : 0);
    this.dispatchStateChangeEvent();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.dispatchStateChangeEvent();
  }

  setEarconsEnabled(enabled: boolean): void {
    this.earconsEnabled = enabled;
    setEarconVolume(enabled ? this.volume : 0);
  }

  setVoiceByUri(uri: string | null): void {
    this.voice = uri ? (this.getVoices().find((v) => v.voiceURI === uri) ?? null) : null;
  }

  /** 'system' follows the device language; anything else is a BCP 47 tag. */
  setLanguage(language: string | null | undefined): void {
    this.language = (language ?? 'system').trim() || 'system';
    // A voice picked for the old language may not match the new one.
    this.voice = null;
  }

  /** The language actually spoken/listened in. */
  getResolvedLanguage(): string {
    return resolveSpeechLanguage(this.language);
  }

  getVoices(): SpeechSynthesisVoice[] {
    return this.synth?.getVoices() ?? [];
  }

  /**
   * Voices load async (Chrome populates after first paint). Wait briefly
   * for voiceschanged instead of speaking with an empty list and going
   * silent. Never throws; returns whatever is available after the timeout.
   */
  async waitForVoices(timeoutMs = 1000): Promise<SpeechSynthesisVoice[]> {
    const existing = this.getVoices();
    if (existing.length > 0) return existing;
    const synth = this.synth;
    if (!synth) return [];
    await new Promise<void>((resolve) => {
      let timer: number | undefined;
      const done = () => {
        if (timer !== undefined) window.clearTimeout(timer);
        synth.removeEventListener('voiceschanged', onChange);
        resolve();
      };
      const onChange = () => done();
      timer = window.setTimeout(done, timeoutMs);
      synth.addEventListener('voiceschanged', onChange);
    });
    return this.getVoices();
  }

  /** Release timers and silence speech. Called on unmount. */
  dispose(): void {
    if (this.watchdog !== null) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    this.stopAll();
  }

  /**
   * Exercise both audio subsystems and report what works. Tries the
   * selected voice first, then other usable voices, so settings can
   * persist a voice that actually spoke.
   */
  async diagnose(): Promise<AudioDiagnostics> {
    const synth = this.synth;
    const voices = this.getVoices();
    const selected = this.resolveVoice();
    const report: AudioDiagnostics = {
      speechSupported: synth !== null,
      voiceCount: voices.length,
      selectedVoice: selected?.name ?? 'System default',
      audioContextState: audioContextState(),
      embeddedBrowser: typeof navigator !== 'undefined' && /\bwv\b/.test(navigator.userAgent),
      speechStarted: false,
      speechEnded: false,
      workingVoiceUri: null,
      voicesTried: [],
      error: null,
      summary: '',
    };
    if (!synth) {
      report.error = 'Speech synthesis is not available in this browser.';
      report.summary = summarise(report);
      return report;
    }
    const candidates = [
      ...(selected ? [selected] : []),
      ...voices.filter((v) => v !== selected && isUsableVoice(v)),
    ].slice(0, 4);
    for (const voice of candidates) {
      const outcome = await this.tryVoice(synth, voice);
      report.voicesTried.push(`${voice.name}: ${outcome}`);
      if (outcome === 'started+ended') {
        report.speechStarted = true;
        report.speechEnded = true;
        report.workingVoiceUri = voice.voiceURI;
        break;
      }
      if (outcome === 'started') report.speechStarted = true;
    }
    if (report.error === null && !report.speechStarted && candidates.length === 0) {
      report.error = 'No voices are available to this browser.';
    }
    report.summary = summarise(report);
    return report;
  }

  private tryVoice(synth: SpeechSynthesis, voice: SpeechSynthesisVoice): Promise<'started+ended' | 'started' | 'failed'> {
    return new Promise((resolve) => {
      const utterance = new SpeechSynthesisUtterance('Testing Blind View voice.');
      utterance.voice = voice;
      utterance.rate = this.rate;
      utterance.volume = this.muted ? 0 : this.volume;
      let started = false;
      const timer = window.setTimeout(() => resolve(started ? 'started' : 'failed'), 5000);
      utterance.onstart = () => { started = true; };
      utterance.onend = () => { window.clearTimeout(timer); resolve(started ? 'started+ended' : 'failed'); };
      utterance.onerror = () => { window.clearTimeout(timer); resolve(started ? 'started' : 'failed'); };
      synth.speak(utterance);
    });
  }

  /**
   * Pick the voice for the resolved language. An explicitly chosen voice
   * wins only when it still exists on this device; a saved URI from
   * another device never blocks speech (pickVoice falls through by
   * language). Returns null when the device has no usable voice at all —
   * the caller then uses Cloud TTS instead of silence.
   */
  private resolveVoice(): SpeechSynthesisVoice | null {
    const voices = this.getVoices();
    if (this.voice) {
      const stillHere = voices.find((v) => v.voiceURI === this.voice?.voiceURI);
      if (stillHere && isUsableVoice(stillHere)) return stillHere;
      this.voice = null;
    }
    const picked = pickVoice(voices as VoiceLike[], {
      language: this.getResolvedLanguage(),
      savedUri: null,
    });
    if (!picked) return null;
    return voices.find((v) => v.voiceURI === picked.voiceURI) ?? null;
  }

  /**
   * Pause all audio playback
   */
  pause(): void {
    if (this._paused) return;
    this._paused = true;
    
    // Cancel current speech if any
    if (this.current) {
      this.cancelCurrent();
    }
    
    // Dispatch event for UI updates
    this.dispatchStateChangeEvent();
  }

  /**
   * Resume audio playback
   */
  resume(): void {
    this._paused = false;
    
    // If we have queued items and are not currently speaking, resume processing
    if (this.queue.length > 0 && !this.current) {
      this.pump();
    }
    
    // Dispatch event for UI updates
    this.dispatchStateChangeEvent();
  }

  /**
   * Event handler for state changes
   */
  private dispatchStateChangeEvent(): void {
    // This creates a custom event that UI components can listen to
    const event = new CustomEvent('audioEngineStateChanged', {
      detail: {
        paused: this._paused,
        speaking: this.current !== null,
        volume: this.volume,
        muted: this.muted
      }
    });
    window.dispatchEvent(event);
  }

  /**
   * Subscribe to audio engine state changes
   */
  public onStateChanged(callback: (state: AudioEngineState) => void): () => void {
    const handler = (event: Event) => {
      const customEvent = event as CustomEvent<AudioEngineState>;
      callback(customEvent.detail);
    };
    
    window.addEventListener('audioEngineStateChanged', handler);
    
    // Return unsubscribe function
    return () => {
      window.removeEventListener('audioEngineStateChanged', handler);
    };
  }

  /**
   * Cancel the current speech utterance if one is happening
   */
  private cancelCurrent(): void {
    this.stopCloudAudio();
    const synth = this.synth;
    if (synth) {
      synth.cancel();
      this.cancelledAt = Date.now();
    }
  }

  private stopCloudAudio(): void {
    if (this.cloudAudio) {
      try { this.cloudAudio.pause(); } catch { /* already stopped */ }
      this.cloudAudio = null;
    }
  }

  /**
   * Speak one queued item via Cloud TTS (MP3) when device speech cannot:
   * no voice on this device, or the engine already proved dead. Same
   * queue/priority as device speech — callers do not change. If cloud
   * also fails, the text stays in the transcript + error (never silent
   * without explanation).
   */
  private async speakViaCloud(item: QueueItem): Promise<void> {
    this.cloudTriedFor = item.id;
    this.silentStreak = 0;
    if (this.onSpeak) this.onSpeak(item);
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ text: item.text, language: this.getResolvedLanguage() }),
      });
      if (!res.ok) throw new Error(`Cloud TTS ${res.status}`);
      const data = (await res.json()) as { audioContent?: string };
      if (!data.audioContent) throw new Error('Cloud TTS returned no audio.');
      const bin = atob(data.audioContent);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
      try {
        this.cloudAudio = new Audio(url);
        await this.cloudAudio.play();
        await new Promise<void>((resolve) => {
          if (!this.cloudAudio) { resolve(); return; }
          this.cloudAudio.onended = () => resolve();
          this.cloudAudio.onerror = () => resolve();
        });
      } finally {
        URL.revokeObjectURL(url);
        this.cloudAudio = null;
      }
    } catch (error) {
      console.error('Cloud TTS fallback failed:', error);
      this.onSpeechUnavailable?.('Speech is not producing audio on this device, and cloud voice also failed. The text is shown on screen.');
    }
    if (this.current && this.current.id === item.id) {
      this.current = null;
      this.pump();
    }
  }

  /**
   * Processes queued items - called when idle or when new items arrive
   */
  private pump(): void {
    // If we're paused or already processing something, don't pump again
    if (this._paused || this.current) return;
    
    if (this.queue.length === 0) return;

    const item = this.queue.shift();
    if (!item) return;

    this.current = item;
    this.dequeueCurrent();
  }

  /**
   * Remove current item from the queue properly and handle cleanup
   */
  private dequeueCurrent(): void {
    const item = this.current;
    if (!item) return;

    const now = Date.now();
    const ttl = item.ttlMs ?? 8000;
    if (now - item.queuedAt > ttl) {
      // Item expired, skip it
      this.current = null;
      return;
    }

    // Device speech already proved dead on this device: go straight to
    // Cloud TTS instead of queueing another silent utterance.
    if (this.speechDead) {
      void this.speakViaCloud(item);
      return;
    }

    const synth = this.synth;
    if (!synth) {
      void this.speakViaCloud(item);
      return;
    }

    // Set up the utterance
    const utterance = new SpeechSynthesisUtterance(item.text);
    utterance.rate = this.rate;
    utterance.pitch = this.pitch;
    utterance.volume = this.muted ? 0 : this.volume;
    // Always set lang: without it the engine may pick a voice for the
    // wrong language (or none) and go silent on non-English systems.
    utterance.lang = this.getResolvedLanguage();
    utterance.voice = this.resolveVoice();
    // No usable voice on this device at all → cloud, not silence.
    // (resolveVoice returns null only when no usable voice exists.)
    if (!utterance.voice) {
      void this.speakViaCloud(item);
      return;
    }

    // Earcon first, speech behind it — the tone lands faster than words.
    if (item.earcon && this.earconsEnabled) playEarcon(item.earcon, item.pan ?? 0);

    // If the engine accepts speech but never starts, it is wedged: count
    // silence and, after repeated failures, say so instead of going quiet.
    let started = false;
    let startTimer: number | undefined;
    const clearStartTimer = () => {
      if (startTimer !== undefined) window.clearTimeout(startTimer);
    };
    
    // Clear previous event listeners
    utterance.onerror = null;
    utterance.onstart = null;
    utterance.onend = null;

    // Handle event callbacks
    utterance.onstart = () => {
      started = true;
      clearStartTimer();
      this.silentStreak = 0;
      this.speechDead = false;
      if (this.onSpeak) {
        this.onSpeak(item);
      }
      // Remove speech-started flag after delay to prevent race condition
      this.utteranceTimer = window.setTimeout(() => {
        if (this.current && this.current.id === item.id) {
          this.current = null; // Release current when speech is considered complete
        }
      }, LOST_COMPLETION_GRACE_MS);
    };

    utterance.onend = () => {
      clearStartTimer();
      if (this.utteranceTimer) {
        clearTimeout(this.utteranceTimer);
        this.utteranceTimer = null;
      }
      
      if (this.current && this.current.id === item.id) {
        this.current = null;
        // Process next item after a small delay to give UI chance to update
        window.setTimeout(() => {
          if (!this._paused) {
            this.pump();
          }
        }, 100);
      }
    };

    utterance.onerror = (event) => {
      clearStartTimer();
      if (this.utteranceTimer) {
        clearTimeout(this.utteranceTimer);
        this.utteranceTimer = null;
      }

      // A cancel (hazard interrupting narration) is not a failure: drop the
      // cancelled utterance and move on. `cancelledAt` marks the interrupt.
      if (event.error === 'canceled' || event.error === 'interrupted' || Date.now() - this.cancelledAt < 500) {
        if (this.current && this.current.id === item.id) this.current = null;
        this.pump();
        return;
      }

      console.error('Speech error:', event);
      // Device voice failed for this utterance → try cloud once before
      // dropping it. A judge must hear the warning, not lose it.
      if (this.cloudTriedFor !== item.id) {
        void this.speakViaCloud(item);
        return;
      }
      if (this.current && this.current.id === item.id) {
        this.current = null;
        this.pump(); // Continue with next item
      }
    };

    synth.speak(utterance);
    startTimer = window.setTimeout(() => {
      if (started) return;
      this.silentStreak += 1;
      if (this.silentStreak >= SILENT_STREAK_LIMIT && !this.speechDead) {
        this.speechDead = true;
        this.onSpeechUnavailable?.('Device speech is not producing audio. Switching to cloud voice.');
      }
      // The engine just proved dead for this utterance: speak it via
      // cloud instead of dropping it and going silent.
      if (this.speechDead && this.cloudTriedFor !== item.id) {
        void this.speakViaCloud(item);
        return;
      }
      if (this.current && this.current.id === item.id) {
        this.current = null;
        this.pump();
      }
    }, ENGINE_START_TIMEOUT_MS);
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
