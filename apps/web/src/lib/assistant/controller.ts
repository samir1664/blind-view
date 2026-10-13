/**
 * Assistant controller: startup, tools, narration scheduler, find loop.
 * Voice-agnostic: works with LiveVoice or ClassicVoice (same shape).
 * Camera is owned by useEngine: controller asks for it via onCameraChange,
 * useEngine opens the stream and calls cameraOpened().
 */
import { authHeaders } from '../firebase';
import type { CapturedFrame } from '../vision/capture';
import { FIND_TICK_MS, isDuplicate, NARRATION_TICK_MS, pickUpdate } from './narration';
import { findExpired, scanGuidance, startFind } from './find';
import type { FindState } from './find';
import { cameraAnnounce, GREETING, HELP_TEXT, READY_TEXT, TAKE_ME_TO_SOON } from './tools';

export interface VoiceLike {
  say(text: string): void;
  interrupt(): void;
  isSpeaking(): boolean;
  userIsTalking?(windowMs?: number): boolean;
  onToolCall: ((call: { id: string; name: string; args: Record<string, unknown> }) => Promise<{ say?: string; ok?: boolean; found?: boolean }>) | null;
  onTranscript: ((role: 'user' | 'model', text: string) => void) | null;
  onUserSpeech: (() => void) | null;
  connect(): Promise<void>;
  close(): void;
}

export interface SceneResult { say: string; facts?: unknown; }
export type SceneTask = 'orient' | 'update' | 'find' | 'read' | 'ask' | 'verify_step';

export interface ControllerOpts {
  voice: VoiceLike;
  getFrame: () => CapturedFrame | null;
  getWalking: () => boolean;
  isMirrored: () => boolean;
  getLocalEvents: () => string[];
  onCameraChange: (which: 'back' | 'front') => void;
  onStatus: (s: string) => void;
  onTranscript: (role: 'user' | 'model', text: string) => void;
}

type Verbosity = 'brief' | 'normal' | 'detailed';

export class AssistantController {
  private voice: VoiceLike;
  private opts: ControllerOpts;
  private lastSay = '';
  private verbosity: Verbosity = 'normal';
  private narrating = false;
  private narrationTimer: ReturnType<typeof setInterval> | null = null;
  private tickCount = 0;
  private findState: FindState | null = null;
  private findTimer: ReturnType<typeof setInterval> | null = null;
  private findTurn = 0;
  private camera: 'back' | 'front' = 'back';
  private cameraChoice: 'back' | 'front' | null = null;
  private started = false;

  constructor(opts: ControllerOpts) {
    this.opts = opts;
    this.voice = opts.voice;
    this.voice.onToolCall = (call) => this.handleTool(call.name, call.args);
    this.voice.onTranscript = (role, text) => this.opts.onTranscript(role, text);
  }

  get isNarrating(): boolean { return this.narrating; }
  get currentCamera(): 'back' | 'front' { return this.camera; }

  private speak(text: string): void {
    const clean = text.trim();
    if (!clean) return;
    if (isDuplicate(this.lastSay, clean)) return;
    this.lastSay = clean;
    this.opts.onTranscript('model', clean);
    this.voice.say(clean);
  }

  /** Force speak even if duplicate (repeat_last). */
  private speakForce(text: string): void {
    const clean = text.trim();
    if (!clean) return;
    this.lastSay = clean;
    this.opts.onTranscript('model', clean);
    this.voice.say(clean);
  }

  private async fetchScene(task: SceneTask, query?: string): Promise<SceneResult | null> {
    const frame = this.opts.getFrame();
    if (!frame) return null;
    try {
      const res = await fetch('/api/scene', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({
          imageBase64: frame.base64, mimeType: frame.mimeType, task,
          query, previous: this.lastSay, localEvents: this.opts.getLocalEvents(),
          walking: this.opts.getWalking(), mirrored: this.opts.isMirrored(), verbosity: this.verbosity,
        }),
      });
      if (!res.ok) return null;
      const data = await res.json() as SceneResult;
      return typeof data.say === 'string' ? data : null;
    } catch { return null; }
  }

  /** Startup: greeting -> camera choice (8s -> back) -> orientation -> ready. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.voice.connect();
    this.opts.onStatus('asking camera');
    this.speakForce(GREETING);
    // Wait up to 8s for switch_camera tool call; else default back.
    const choice = await new Promise<'back' | 'front'>((resolve) => {
      const timer = setTimeout(() => resolve('back'), 8000);
      const poll = setInterval(() => {
        if (this.cameraChoice) { clearTimeout(timer); clearInterval(poll); resolve(this.cameraChoice); }
      }, 200);
    });
    this.camera = choice;
    this.opts.onCameraChange(choice);
    this.speak(cameraAnnounce(choice));
    // Orientation: place first, nothing interrupts except imminent collision (handled by safety layer).
    const orient = await this.fetchScene('orient');
    if (orient?.say) this.speak(orient.say);
    this.speak(READY_TEXT);
    this.opts.onStatus('ready');
  }

  /** Called by useEngine after camera stream opens. */
  cameraOpened(which: 'back' | 'front'): void { this.camera = which; }

  async handleTool(name: string, args: Record<string, unknown>): Promise<{ say?: string; ok?: boolean; found?: boolean }> {
    switch (name) {
      case 'switch_camera': {
        const which = args.which === 'front' ? 'front' : 'back';
        this.cameraChoice = which;
        this.camera = which;
        this.opts.onCameraChange(which);
        return { say: cameraAnnounce(which), ok: true };
      }
      case 'where_am_i': {
        const r = await this.fetchScene('orient');
        return { say: r?.say || "I'm not sure where you are yet. Try holding the phone steady.", ok: !!r };
      }
      case 'describe_now': {
        const r = await this.fetchScene('update');
        return { say: r?.say || "I can't describe the view yet.", ok: !!r };
      }
      case 'start_narration': this.startNarration(); return { say: 'Starting narration.', ok: true };
      case 'stop_narration': this.stopNarration(); return { say: 'Narration stopped.', ok: true };
      case 'find_object': {
        const target = typeof args.name === 'string' ? args.name : '';
        if (!target) return { say: 'What should I look for?', ok: false };
        this.startFinding(target);
        return { say: `Looking for ${target}.`, ok: true };
      }
      case 'stop_finding': this.stopFinding(); return { say: 'Stopped searching.', ok: true };
      case 'read_text': {
        const r = await this.fetchScene('read');
        return { say: r?.say || "I can't read any text yet.", ok: !!r };
      }
      case 'ask_about_view': {
        const q = typeof args.question === 'string' ? args.question : '';
        const r = await this.fetchScene('ask', q);
        return { say: r?.say || "I'm not sure.", ok: !!r };
      }
      case 'take_me_to': return { say: TAKE_ME_TO_SOON, ok: true };
      case 'repeat_last': return { say: this.lastSay || 'Nothing to repeat yet.', ok: true };
      case 'more_detail': this.verbosity = 'detailed'; return { say: 'Okay, more detail.', ok: true };
      case 'less_detail': this.verbosity = 'brief'; return { say: 'Okay, shorter.', ok: true };
      case 'help': return { say: HELP_TEXT, ok: true };
      default: return { say: '', ok: false };
    }
  }

  startNarration(): void {
    if (this.narrating) return;
    this.narrating = true;
    this.tickCount = 0;
    this.narrationTimer = setInterval(() => void this.narrationTick(), NARRATION_TICK_MS);
  }
  stopNarration(): void {
    this.narrating = false;
    if (this.narrationTimer) clearInterval(this.narrationTimer);
    this.narrationTimer = null;
  }

  private async narrationTick(): Promise<void> {
    if (!this.narrating) return;
    if (this.voice.isSpeaking() || this.voice.userIsTalking?.(2500)) return;
    this.tickCount += 1;
    const r = await this.fetchScene('update');
    if (!this.narrating) return;
    const picked = pickUpdate({ sceneSay: r?.say ?? '', lastSay: this.lastSay, tickCount: this.tickCount, changed: !!r?.say });
    if (picked) this.speak(picked);
  }

  startFinding(target: string): void {
    this.stopFinding();
    this.findState = startFind(target);
    this.findTurn = 0;
    void this.findTick();
    this.findTimer = setInterval(() => void this.findTick(), FIND_TICK_MS);
  }
  stopFinding(): void {
    if (this.findTimer) clearInterval(this.findTimer);
    this.findTimer = null;
    this.findState = null;
  }

  private async findTick(): Promise<void> {
    const st = this.findState;
    if (!st) return;
    if (findExpired(st)) { this.speak(`I couldn't find ${st.target} in a minute. Try moving the phone slowly.`); this.stopFinding(); return; }
    if (this.voice.isSpeaking()) return;
    const r = await this.fetchScene('find', st.target);
    if (!this.findState) return;
    if (r?.say && !isDuplicate(st.lastGuidance, r.say)) {
      st.lastGuidance = r.say;
      this.speak(r.say);
      // If scene says found (facts.found), stop. Server returns found in facts.
      const found = (r.facts as { found?: boolean } | undefined)?.found;
      if (found) { this.stopFinding(); return; }
    } else if (!r?.say) {
      const g = scanGuidance(this.findTurn++);
      this.speak(g);
    }
  }

  /** UI buttons: run a tool and speak its answer directly (no Live round-trip). */
  async runToolAndSpeak(name: string, args: Record<string, unknown> = {}): Promise<void> {
    const r = await this.handleTool(name, args);
    if (r.say) this.speakForce(r.say);
  }

  interrupt(): void { this.voice.interrupt(); }
  close(): void { this.stopNarration(); this.stopFinding(); this.voice.close(); }
}
