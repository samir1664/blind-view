/**
 * ClassicVoice fallback: browser SpeechRecognition + keyword parser + Cloud TTS.
 * Same tool/narration interface as LiveVoice, so AssistantController works unchanged.
 * Device TTS is offline last resort for hazard alerts only.
 */
import { authHeaders } from '../firebase';
import { resolveSpeechLanguage } from '../audio/voice';
import { useSettings } from '../../store/settings';

/** Language for ClassicVoice STT + Cloud TTS: saved setting, else system. */
function classicLanguage(): string {
  return resolveSpeechLanguage(useSettings.getState().language);
}

interface ToolCall { id: string; name: string; args: Record<string, unknown>; }
interface ToolResult { say?: string; ok?: boolean; found?: boolean; }

function parseKeyword(text: string): ToolCall | null {
  const t = text.toLowerCase().trim();
  const id = `classic-${Date.now()}`;
  if (/\bwhere am i\b|what.*place/.test(t)) return { id, name: 'where_am_i', args: {} };
  if (/\bnarrat|describe as i walk|keep (telling|describing)/.test(t)) return { id, name: 'start_narration', args: {} };
  if (/\b(stop|quiet|pause)\b.*(narrat|talk)/.test(t) || t === 'stop') return { id, name: 'stop_narration', args: {} };
  const find = t.match(/\b(?:find|where is|where\u2019s)\s+(?:my\s+)?(.+)/);
  if (find?.[1]) return { id, name: 'find_object', args: { name: find[1] } };
  if (/\b(got it|found it|stop searching)\b/.test(t)) return { id, name: 'stop_finding', args: {} };
  if (/\bread|what does it say/.test(t)) return { id, name: 'read_text', args: {} };
  if (/\bdescribe|what.*front/.test(t)) return { id, name: 'describe_now', args: {} };
  if (/\btake me to\b/.test(t)) return { id, name: 'take_me_to', args: { place: t.replace(/.*take me to\s*/, '') } };
  if (/\bswitch camera|front camera|back camera\b/.test(t)) return { id, name: 'switch_camera', args: { which: /front/.test(t) ? 'front' : 'back' } };
  if (/\brepeat|say again/.test(t)) return { id, name: 'repeat_last', args: {} };
  if (/\bmore detail/.test(t)) return { id, name: 'more_detail', args: {} };
  if (/\b(shorter|less detail)/.test(t)) return { id, name: 'less_detail', args: {} };
  if (/\bhelp|what can you do/.test(t)) return { id, name: 'help', args: {} };
  if (t.length > 2) return { id, name: 'ask_about_view', args: { question: text } };
  return null;
}

export class ClassicVoice {
  onToolCall: ((call: ToolCall) => Promise<ToolResult>) | null = null;
  onTranscript: ((role: 'user' | 'model', text: string) => void) | null = null;
  onUserSpeech: (() => void) | null = null;
  onState: ((state: string, message?: string) => void) | null = null;

  private audio: HTMLAudioElement | null = null;
  private recognition: unknown = null;
  private lastUserSpeechAt = 0;
  private speaking = false;

  async connect(): Promise<void> {
    this.startRecognition();
    this.onState?.('ready');
  }
  close(): void {
    this.interrupt();
    const rec = this.recognition as { stop?: () => void } | null;
    try { rec?.stop?.(); } catch { /* already stopped */ }
    this.recognition = null;
  }

  async say(text: string): Promise<void> {
    const clean = text.trim();
    if (!clean) return;
    this.interrupt();
    this.speaking = true;
    this.onTranscript?.('model', clean);
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ text: clean, language: classicLanguage() }),
      });
      if (res.ok) {
        const data = await res.json() as { audioContent?: string };
        if (data.audioContent) { await this.playBase64Mp3(data.audioContent); return; }
      }
      throw new Error('TTS unavailable');
    } catch {
      // Offline last resort: device TTS.
      await this.speakDevice(clean);
    } finally { this.speaking = false; }
  }

  interrupt(): void {
    this.audio?.pause();
    this.audio = null;
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    this.speaking = false;
  }
  isSpeaking(): boolean { return this.speaking || (typeof window !== 'undefined' && 'speechSynthesis' in window && window.speechSynthesis.speaking); }
  userIsTalking(windowMs = 2500): boolean { return Date.now() - this.lastUserSpeechAt < windowMs; }
  sendText(text: string): void { void this.handleHeard(text); }

  private async playBase64Mp3(b64: string): Promise<void> {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
    try {
      this.audio = new Audio(url);
      await this.audio.play();
      await new Promise<void>((resolve) => { if (this.audio) this.audio.onended = () => resolve(); });
    } finally { URL.revokeObjectURL(url); this.audio = null; }
  }

  private speakDevice(text: string): Promise<void> {
    return new Promise((resolve) => {
      if (!('speechSynthesis' in window)) { resolve(); return; }
      const u = new SpeechSynthesisUtterance(text);
      u.lang = classicLanguage();
      u.onend = () => resolve(); u.onerror = () => resolve();
      window.speechSynthesis.speak(u);
    });
  }

  private startRecognition(): void {
    const Ctor = (window as unknown as { SpeechRecognition?: new () => unknown; webkitSpeechRecognition?: new () => unknown }).SpeechRecognition
      ?? (window as unknown as { webkitSpeechRecognition?: new () => unknown }).webkitSpeechRecognition;
    if (!Ctor) return;
    try {
      const rec = new Ctor() as { continuous: boolean; interimResults: boolean; lang: string; onresult: ((e: { results: ArrayLike<{ [i: number]: { transcript: string }; isFinal: boolean }> }) => void) | null; onend: (() => void) | null; start: () => void };
      rec.continuous = true; rec.interimResults = false; rec.lang = classicLanguage();
      rec.onresult = (e) => {
        const last = e.results[e.results.length - 1];
        const transcript = last?.[0]?.transcript ?? '';
        if (!transcript.trim() || !last?.isFinal) return;
        this.lastUserSpeechAt = Date.now();
        this.onUserSpeech?.();
        this.onTranscript?.('user', transcript);
        void this.handleHeard(transcript);
      };
      rec.onend = () => { /* keep listening: restart once if still connected */ try { rec.start(); } catch { /* stopped */ } };
      rec.start();
      this.recognition = rec;
    } catch { /* STT unavailable: buttons still work */ }
  }

  private async handleHeard(text: string): Promise<void> {
    const call = parseKeyword(text);
    if (!call || !this.onToolCall) return;
    try {
      const result = await this.onToolCall(call);
      if (result.say) await this.say(result.say);
    } catch { /* keep listening */ }
  }
}
