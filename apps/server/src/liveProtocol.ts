/**
 * The Live relay's message contract.
 *
 * The phone never talks to Vertex directly: it speaks a tiny JSON protocol to
 * our server, and this file translates both ways. Everything that shapes the
 * model's behaviour — which model, the system instruction, the tools — is
 * fixed here on the server, so a modified client cannot repurpose our budget.
 */

export const LIVE_TOOL_NAMES = [
  'where_am_i',
  'describe_now',
  'start_narration',
  'stop_narration',
  'find_object',
  'stop_finding',
  'read_text',
  'ask_about_view',
  'take_me_to',
  'switch_camera',
  'repeat_last',
  'more_detail',
  'less_detail',
] as const;
export type LiveToolName = (typeof LIVE_TOOL_NAMES)[number];

const NO_ARGS = { type: 'OBJECT', properties: {} };

const TOOL_DECLARATIONS: Array<{ name: LiveToolName; description: string; parameters: unknown }> = [
  { name: 'where_am_i', description: 'Tell the user what kind of place they are in and the situation around them (place, traffic, layout, walking path).', parameters: NO_ARGS },
  { name: 'describe_now', description: 'Describe what is in front of the user right now, once.', parameters: NO_ARGS },
  { name: 'start_narration', description: 'Start continuous live narration of the surroundings while the user walks. Use when they ask to narrate, describe as I walk, guide me, or keep telling me.', parameters: NO_ARGS },
  { name: 'stop_narration', description: 'Stop continuous narration.', parameters: NO_ARGS },
  {
    name: 'find_object',
    description: 'Search the camera view for a specific object the user wants to find, then keep guiding them to it.',
    parameters: {
      type: 'OBJECT',
      properties: { name: { type: 'STRING', description: 'The object, in the user\'s words, e.g. "my goggles", "purse", "shoes".' } },
      required: ['name'],
    },
  },
  { name: 'stop_finding', description: 'Stop searching for the object (the user found it or gave up).', parameters: NO_ARGS },
  { name: 'read_text', description: 'Read any text in view: signs, labels, medicine, screens, money notes.', parameters: NO_ARGS },
  {
    name: 'ask_about_view',
    description: 'Answer a specific question about what is in front of the user that the other tools do not cover.',
    parameters: {
      type: 'OBJECT',
      properties: { question: { type: 'STRING', description: 'The user\'s question.' } },
      required: ['question'],
    },
  },
  {
    name: 'take_me_to',
    description: 'The user wants to be guided to a place, e.g. a barber shop, bakery, medical shop.',
    parameters: {
      type: 'OBJECT',
      properties: { place: { type: 'STRING', description: 'Where they want to go.' } },
      required: ['place'],
    },
  },
  {
    name: 'switch_camera',
    description: 'Choose or switch the camera. Use for answers like "back", "front", "rear", "selfie".',
    parameters: {
      type: 'OBJECT',
      properties: { which: { type: 'STRING', enum: ['back', 'front'] } },
      required: ['which'],
    },
  },
  { name: 'repeat_last', description: 'Repeat the last thing the assistant said.', parameters: NO_ARGS },
  { name: 'more_detail', description: 'The user wants longer, more detailed descriptions.', parameters: NO_ARGS },
  { name: 'less_detail', description: 'The user wants shorter descriptions.', parameters: NO_ARGS },
];

const SYSTEM_INSTRUCTION = `You are Blind View, a calm, efficient eye assistant for a blind person. You talk with them by voice.

YOU CANNOT SEE. You only know what your tools return. Never describe surroundings, objects, text or people from imagination or from earlier knowledge.

WHEN THE USER ASKS FOR SOMETHING, CALL A TOOL:
- "where am I", "what is this place" -> where_am_i
- "what's in front of me", "describe" -> describe_now
- "narrate", "guide me", "tell me as I walk", "keep describing" -> start_narration; "stop", "quiet", "pause" while narrating -> stop_narration
- "find", "where is my ..." -> find_object; "got it", "found it", "stop searching" -> stop_finding
- "read this", "what does it say", "what note is this" -> read_text
- any other question about the view -> ask_about_view
- "take me to ...", "how do I get to ..." -> take_me_to
- "back"/"front"/"rear"/"selfie" camera answers or "switch camera" -> switch_camera
- "repeat", "say again" -> repeat_last; "more detail" -> more_detail; "shorter" -> less_detail

AFTER A TOOL RETURNS: speak its "say" field exactly, word for word, and nothing else. If "say" is empty, stay silent.

MESSAGES THAT START WITH [SAY]: speak exactly the text after [SAY], word for word, nothing added, and do not call any tool.

YOUR OWN WORDS: only very short acknowledgements ("Okay.", "Sure."), and only when no tool result follows immediately. Never give distances as numbers. Never say it is safe to cross a road. Never ask the user to look at something. Speak English, calmly and clearly.`;

export interface LiveSetupOptions {
  project: string;
  location: string;
  model: string;
  voice?: string;
  resumeHandle?: string;
}

export function buildLiveSetup(options: LiveSetupOptions) {
  return {
    setup: {
      model: `projects/${options.project}/locations/${options.location}/publishers/google/models/${options.model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: options.voice ?? 'Aoede' } } },
      },
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: { handle: options.resumeHandle },
    },
  };
}

// ── Client → upstream ─────────────────────────────────────────

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** ~2 s of 16 kHz 16-bit mono PCM, base64-encoded. Chunks are ~100 ms. */
const MAX_AUDIO_B64 = 90_000;
const MAX_SAY = 1200;
const MAX_TEXT = 300;

function bounded(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim().slice(0, max);
  return text.length > 0 ? text : null;
}

function userTurn(text: string) {
  return { clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } };
}

export function mapClientMessage(message: unknown): unknown | null {
  if (!message || typeof message !== 'object') return null;
  const m = message as Record<string, unknown>;

  switch (m.type) {
    case 'audio': {
      const data = m.data;
      if (typeof data !== 'string' || data.length === 0 || data.length > MAX_AUDIO_B64 || !BASE64.test(data)) {
        return null;
      }
      return { realtimeInput: { audio: { data, mimeType: 'audio/pcm;rate=16000' } } };
    }
    case 'say': {
      const text = bounded(m.text, MAX_SAY);
      return text ? userTurn(`[SAY] ${text}`) : null;
    }
    case 'text': {
      const text = bounded(m.text, MAX_TEXT);
      return text ? userTurn(text) : null;
    }
    case 'tool_result': {
      const id = bounded(m.id, 100);
      const name = m.name;
      if (!id || !LIVE_TOOL_NAMES.includes(name as LiveToolName)) return null;
      // Only a fixed, small shape reaches the model: whatever else a client
      // sends is dropped rather than forwarded into the conversation.
      const raw = m.response && typeof m.response === 'object' ? (m.response as Record<string, unknown>) : {};
      const response: Record<string, unknown> = {};
      const say = bounded(raw.say, MAX_SAY);
      if (say) response.say = say;
      if (typeof raw.ok === 'boolean') response.ok = raw.ok;
      if (typeof raw.found === 'boolean') response.found = raw.found;
      return { toolResponse: { functionResponses: [{ id, name, response }] } };
    }
    default:
      return null;
  }
}

// ── Upstream → client ─────────────────────────────────────────

export type ClientEvent =
  | { type: 'ready' }
  | { type: 'audio'; data: string }
  | { type: 'interrupted' }
  | { type: 'turn_complete' }
  | { type: 'transcript'; role: 'user' | 'model'; text: string }
  | { type: 'tool_call'; calls: Array<{ id: string; name: string; args: Record<string, unknown> }> }
  | { type: 'tool_cancel'; ids: string[] };

export interface UpstreamControl {
  goAway?: boolean;
  resumeHandle?: string;
}

export function mapUpstreamMessage(message: unknown): ClientEvent[] {
  if (!message || typeof message !== 'object') return [];
  const m = message as Record<string, any>;
  const out: ClientEvent[] = [];

  if (m.setupComplete) out.push({ type: 'ready' });

  const sc = m.serverContent;
  if (sc) {
    for (const part of sc.modelTurn?.parts ?? []) {
      const data = part?.inlineData?.data;
      if (typeof data === 'string' && /^audio\//.test(part.inlineData.mimeType ?? 'audio/pcm')) {
        out.push({ type: 'audio', data });
      }
    }
    if (typeof sc.inputTranscription?.text === 'string' && sc.inputTranscription.text) {
      out.push({ type: 'transcript', role: 'user', text: sc.inputTranscription.text });
    }
    if (typeof sc.outputTranscription?.text === 'string' && sc.outputTranscription.text) {
      out.push({ type: 'transcript', role: 'model', text: sc.outputTranscription.text });
    }
    if (sc.interrupted) out.push({ type: 'interrupted' });
    if (sc.turnComplete) out.push({ type: 'turn_complete' });
  }

  const calls = m.toolCall?.functionCalls;
  if (Array.isArray(calls) && calls.length > 0) {
    out.push({
      type: 'tool_call',
      calls: calls
        .filter((c: any) => typeof c?.name === 'string')
        .map((c: any) => ({ id: String(c.id ?? ''), name: c.name, args: c.args && typeof c.args === 'object' ? c.args : {} })),
    });
  }

  const cancelled = m.toolCallCancellation?.ids;
  if (Array.isArray(cancelled)) out.push({ type: 'tool_cancel', ids: cancelled.map(String) });

  return out;
}

/** Session-management signals the relay handles itself (never sent to the phone). */
export function upstreamControl(message: unknown): UpstreamControl {
  if (!message || typeof message !== 'object') return {};
  const m = message as Record<string, any>;
  const control: UpstreamControl = {};
  if (m.goAway) control.goAway = true;
  const update = m.sessionResumptionUpdate;
  if (update?.resumable && typeof update.newHandle === 'string' && update.newHandle) {
    control.resumeHandle = update.newHandle;
  }
  return control;
}
