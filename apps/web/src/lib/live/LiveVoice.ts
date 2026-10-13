import { createPlayer, startMic, unlockLiveAudio } from './audio-io';
import type { Mic, Player } from './audio-io';
import { firebaseTokens } from '../firebase';

/**
 * The assistant's voice: a Gemini Live conversation relayed through our
 * server (/api/live). Live hears the user, decides which tool to call, and
 * speaks. It never sees the camera — every visual answer comes from our
 * vision tools, so it cannot describe what it has not been told.
 */

export type LiveState = 'idle' | 'connecting' | 'ready' | 'closed' | 'error';

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  say?: string;
  ok?: boolean;
  found?: boolean;
}

const CONNECT_TIMEOUT_MS = 12_000;

function liveUrl(): string {
  const configured = import.meta.env.VITE_LIVE_URL as string | undefined;
  if (configured) return configured;
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/api/live`;
}

export class LiveVoice {
  onToolCall: ((call: ToolCall) => Promise<ToolResult>) | null = null;
  /** Full turns: model text once a turn completes; user text as it streams. */
  onTranscript: ((role: 'user' | 'model', text: string) => void) | null = null;
  onState: ((state: LiveState, message?: string) => void) | null = null;
  /** Fires when the user starts talking, so narration can hold back. */
  onUserSpeech: (() => void) | null = null;

  private socket: WebSocket | null = null;
  private player: Player | null = null;
  private mic: Mic | null = null;
  private modelText = '';
  private state: LiveState = 'idle';
  private lastUserSpeechAt = 0;

  get current(): LiveState {
    return this.state;
  }

  /** Call inside the Start tap. Resolves when the voice is ready. */
  async connect(): Promise<void> {
    if (this.state === 'ready' || this.state === 'connecting') return;
    await unlockLiveAudio();
    this.setState('connecting');
    // createPlayer now returns a Promise<Player> and uses an AudioWorklet for low‑latency playback.
    this.player = await createPlayer();

    const socket = new WebSocket(liveUrl());
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Live voice did not answer in time.'));
        socket.close();
      }, CONNECT_TIMEOUT_MS);

      socket.onopen = () => {
        void firebaseTokens().then((tokens) => {
          if (tokens) socket.send(JSON.stringify({ type: 'auth', ...tokens }));
        });
      };

      socket.onmessage = (event) => {
        let message: Record<string, any>;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (message.type === 'ready' && this.state === 'connecting') {
          clearTimeout(timer);
          this.setState('ready');
          resolve();
          return;
        }
        if (message.type === 'error') {
          clearTimeout(timer);
          this.setState('error', message.message);
          reject(new Error(message.message ?? 'Live voice error.'));
          return;
        }
        this.handle(message);
      };

      socket.onclose = (event) => {
        clearTimeout(timer);
        if (this.state === 'connecting') reject(new Error(`Live voice closed (${event.code}).`));
        if (this.state !== 'error') this.setState('closed');
        this.stopAudio();
      };
    });

    this.mic = await startMic(
      (chunk) => this.send({ type: 'audio', data: chunk }),
      () => this.isSpeaking(),
    );
  }

  /** Speak exact text in the assistant's voice. */
  say(text: string): void {
    const clean = text.trim();
    if (clean) this.send({ type: 'say', text: clean });
  }

  /** Behave as if the user had said this (used by on-screen buttons). */
  sendText(text: string): void {
    const clean = text.trim();
    if (clean) this.send({ type: 'text', text: clean });
  }

  /** Cut the assistant off immediately (hazard, or user takes over). */
  interrupt(): void {
    this.player?.flush();
    this.modelText = '';
  }

  isSpeaking(): boolean {
    return this.player?.isPlaying() ?? false;
  }

  /** True while the user has spoken in the last few seconds. */
  userIsTalking(windowMs = 2500): boolean {
    return Date.now() - this.lastUserSpeechAt < windowMs;
  }

  setVolume(value: number): void {
    this.player?.setGain(value);
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
    this.stopAudio();
    this.setState('closed');
  }

  private handle(message: Record<string, any>): void {
    switch (message.type) {
      case 'audio':
        this.player?.enqueue(message.data);
        break;
      case 'interrupted':
        // The user started talking over the assistant: stop at once.
        this.interrupt();
        break;
      case 'transcript':
        if (message.role === 'user') {
          this.lastUserSpeechAt = Date.now();
          this.onUserSpeech?.();
          this.onTranscript?.('user', message.text);
        } else {
          this.modelText += message.text;
        }
        break;
      case 'turn_complete':
        if (this.modelText.trim()) this.onTranscript?.('model', this.modelText.trim());
        this.modelText = '';
        break;
      case 'tool_call':
        for (const call of message.calls as ToolCall[]) void this.runTool(call);
        break;
      case 'tool_cancel':
        // Server cancelled a pending tool turn (e.g. user interrupted): stop
        // speaking that turn, drop pending text, do not crash or send result.
        this.interrupt();
        break;
      default:
        break;
    }
  }

  private async runTool(call: ToolCall): Promise<void> {
    let result: ToolResult;
    try {
      result = (await this.onToolCall?.(call)) ?? { ok: false };
    } catch (error) {
      console.warn('[live] tool failed', call.name, error);
      result = { ok: false, say: 'Sorry, that did not work. Please try again.' };
    }
    this.send({ type: 'tool_result', id: call.id, name: call.name, response: result });
  }

  private send(message: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private stopAudio(): void {
    this.mic?.stop();
    this.mic = null;
    this.player?.flush();
  }

  private setState(state: LiveState, message?: string): void {
    this.state = state;
    this.onState?.(state, message);
  }
}
