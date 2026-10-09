# Section 2 — Eye Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline). Steps use checkbox syntax.

**Goal:** Voice-first eye assistant: greeting → camera choice → place orientation → voice menu (where am I, find, narrate, read, describe, ask, take-me-to stub), accurate vision with code-computed directions, and a quiet, correct safety layer.

**Architecture:** Server gains `/api/scene` (Gemini 3.8 Flash structured JSON + geometry → speech with computed directions), `/api/live` (WebSocket relay to Vertex Live `us-central1`, server-owned setup + tools), `/api/tts` (Cloud TTS fallback). Client gains a Live voice client with its own mic/playback worklets, an assistant controller (start-up, tools, narration scheduler, find loop), and a reworked safety layer.

**Tech Stack:** Hono + @hono/node-ws + ws, google-auth-library, Vertex AI (gemini-3.8-flash, gemini-live-2.5-flash-native-audio), Cloud Text-to-Speech, React/Vite, AudioWorklet, MediaPipe Tasks Vision.

**Spec:** `docs/superpowers/specs/2026-10-09-section2-eye-assistant-design.md` (requirements R1–R11, rules E1–E9, fixes F1–F5, acceptance A1–A5).

## Global Constraints
- Never speak distances as numbers (R8). Allowed proximity words only: "right in front of you", "within reach", "a few steps ahead", "further ahead".
- Directions come only from server geometry (E3). Model output containing raw direction words for objects is not trusted.
- Live upstream: `wss://us-central1-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent`, model `projects/blind-view-ai/locations/us-central1/publishers/google/models/gemini-live-2.5-flash-native-audio`.
- Live is audio-only (no video frames); vision only via `/api/scene`.
- Client cannot set model, system instruction or tools for Live.
- All paid endpoints and the WebSocket require the Section 1 guard (App Check + ID token) when `REQUIRE_APP_CHECK=true`.
- English only in this section.

## Review Focus
- User speaks while the assistant is talking → playback flushes within 1 s (A4).
- Live upstream drops / goAway after ~10 min → transparent reconnect with session resumption; narration continues.
- Front camera → left/right mirrored correctly in geometry.
- Model returns malformed JSON or unknown placeholder ids → speech still clean (placeholders removed), no crash.
- User walking past parked cars → no "coming towards you" (A3).

---

### Task S2-1: Scene geometry (server) — directions, proximity, placeholders
Files: create `apps/server/src/geometry.ts`, `geometry.test.ts`.
Interfaces: `directionOf(box: [ymin,xmin,ymax,xmax], mirrored: boolean): Direction` (5 sectors: 'on your left' | 'slightly left' | 'straight ahead' | 'slightly right' | 'on your right'); `proximityOf(box): Proximity` ('right in front of you' | 'within reach' | 'a few steps ahead' | 'further ahead'); `fillPlaceholders(say: string, objects: SceneObject[], mirrored: boolean): string` replaces `{dir:id}` / `{near:id}`, drops unknown ids cleanly.
- [ ] failing tests (sectors, mirroring, proximity bands, placeholder fill, unknown id, no leftover braces) → implement → pass → commit.

### Task S2-2: `/api/scene` (server) — DONE
- Benchmark (real photos: Bangalore traffic, Kolkata living room, office): **gemini-3.5-flash-lite + thinking low = 2.7–3.6 s**, correct place/traffic/sides. 3.5 Flash 7.6 s/timeouts; 3.8 Flash timeouts; 3.8 rejects thinking "minimal".
- Finding: single-frame motion direction is unreliable (3.8 said rickshaw "away", Flash-Lite "towards" on the same photo) → prompt forbids "towards/away" claims unless on-device tracker events say so. Motion direction comes ONLY from the client tracker.
- Read task: empty `text` → fixed honest sentence enforced in code (`speechFor`).
Files: create `apps/server/src/scene.ts`, `scenePrompts.ts`, `scene.test.ts`; modify `index.ts`.
Interfaces: `POST /api/scene` body `{ imageBase64, mimeType, task: 'orient'|'update'|'find'|'read'|'ask'|'verify_step', query?, previous?, localEvents?: string[], walking?: boolean, mirrored?: boolean, verbosity? }` → `{ say: string, facts: SceneFacts, latencyMs }`.
- Gemini `gemini-3.8-flash` (fallback `gemini-3.5-flash`), `responseSchema` for objects/place/path/text/say, thinking low.
- [ ] tests for parse/validate/clamp (`parseSceneResponse`) and prompt building per task → implement → smoke with a real image (office photo) → commit.

### Task S2-3: Live relay (server)
Files: create `apps/server/src/live.ts`, `liveSetup.ts`, `liveSetup.test.ts`; modify `index.ts`, `package.json` (+ `@hono/node-ws`, `ws`).
Protocol (client⇄server JSON): C→S `auth{appCheck,idToken}`, `audio{data}`, `say{text}`, `text{text}`, `tool_result{id,name,response}`; S→C `ready`, `audio{data}`, `interrupted`, `turn_complete`, `transcript{role,text}`, `tool_call{calls}`, `error{message}`.
- Server builds setup: model, system instruction, tools (S2 tool list), `contextWindowCompression.slidingWindow`, `sessionResumption`, input+output transcription. On `goAway` reconnects upstream with the latest resumption handle.
- Auth: first client message must be `auth` within 5 s when required; else close 4401.
- Cloud Run: `--timeout 3600`.
- [ ] tests for setup builder + message mapping → implement → smoke with a node client script → commit.

### Task S2-4: Audio I/O (web)
Files: create `apps/web/src/lib/live/mic-worklet.ts`, `player-worklet.ts`, `audio-io.ts`.
Interfaces: `startMic(onChunk: (b64Pcm16k: string) => void): Promise<() => void>`; `createPlayer(): { enqueue(b64Pcm24k), flush(), setGain(0..1), isPlaying(): boolean }`.
- [ ] implement; verify in browser (tone playback, mic level).

### Task S2-5: Live voice client (web)
Files: create `apps/web/src/lib/live/LiveVoice.ts`.
Interfaces: `connect()`, `close()`, `say(text)`, `sendText(text)`, `interrupt()`, events `onToolCall`, `onTranscript`, `onState`.
- Uses `authHeaders` tokens in the `auth` message; connects to `VITE_LIVE_URL` (Cloud Run wss URL) or same-origin in dev.
- [ ] implement; verify end-to-end locally: say "hello" → audio heard; speak → transcript arrives.

### Task S2-6: Assistant controller (web)
Files: create `apps/web/src/lib/assistant/controller.ts`, `narration.ts`, `find.ts`, `tools.ts`; tests for scheduler rules (`narration.test.ts` via vitest-free pure functions run with tsx).
- Start-up sequence (spec §6), tool handlers, narration scheduler (6 s tick, change-priority, no identical repeats, skip while speaking/user talking), find loop (2 s, 60 s cap).
- [ ] implement pure scheduler logic test-first; wire into `useEngine`; verify locally.

### Task S2-7: Quiet, correct safety layer (web)
Files: modify `tracking.ts`, `terrain.ts`, `freespace.ts`, `director.ts`; create `motion.ts`.
- Walking detection (DeviceMotion step cadence); ego-motion gate for "approaching" (F3); step candidate persistence ≥3 frames + `/api/scene verify_step` before speaking (F1); local path phrases removed from speech → context (F2, F5); imminent-only local speech; hazard cuts Live playback.
- [ ] extend `scripts/simulate-guide.ts` with walking-past-parked-car and static-desk scenarios that must produce no speech → implement → pass → commit.

### Task S2-8: MediaPipe EfficientDet (web)
Files: modify `vision/detector.ts`, `vite.config.ts`, `setup-assets.mjs`; remove TFJS deps.
- [ ] implement; compare detections on test images; commit.

### Task S2-9: UI (web)
Files: modify `App.tsx`, `styles.css`.
- One big Start/Stop; status line (listening / speaking / thinking); large buttons mirroring the voice menu; transcript.
- [ ] implement; screen-reader labels check.

### Task S2-10: Fallback voice (Cloud TTS + browser STT)
Files: create `apps/server/src/tts.ts`; `apps/web/src/lib/assistant/ClassicVoice.ts`; enable `texttospeech.googleapis.com`.
- [ ] implement; auto-switch when Live fails; verify.

### Task S2-11: Deploy + field acceptance
- [ ] deploy API (preview tag first) + web; user runs A1–A5 in office, home, street; fix findings.
