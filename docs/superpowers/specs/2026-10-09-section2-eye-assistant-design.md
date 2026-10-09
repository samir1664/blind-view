# Section 2 — Eye Assistant: Design

Status: draft 2026-10-09, built from the user's field test, the user's requested experience, and the research summary in `2026-10-08-hackathon-roadmap.md`. **Every numbered requirement below must be implemented or explicitly deferred with a reason.**

## 1. Goal
Turn Blind View from "a camera that shouts single words" into a **voice-first eye assistant**:
- it talks to the user;
- it describes the **place first**, then narrates in full sentences with directions;
- it finds things;
- it answers questions;
- it warns only about **real, confirmed** dangers.

## 2. User requirements (from the user, verbatim intent) — checklist
- R1. On start it speaks: "Hi, I am your eye assistant. Which camera should I use, back or front?" It then opens that camera.
- R2. Then: "Eye assistant is ready. What would you like?", offering the options below.
- R3. **Take me to <place>** (barber, bakery, medical shop). *Full navigation is Section 3.* In Section 2 the intent is recognised and answered honestly ("Navigation is coming soon, I can tell you what's around you now").
- R4. **Where am I?** answers with the place type and situation: home, office, shop…, street with light / moderate / heavy traffic, park or forest, closed room.
- R5. **Find <object>** (goggles, purse, shoes): says where it is with a direction, then guides the user's hand or steps until it is reached. If the object isn't visible, it tells the user how to turn.
- R6. **Narrate the live scene**. The **first** utterance describes the place and overall situation. After that come **regular short updates every few seconds** about:
  - what changed;
  - moving objects (a person coming towards you or passing on your left, an animal, a vehicle);
  - the current path ("way ahead is clear", "corridor continues").
  
  Updates must not be irritating: no identical repeats, and no bare words like "Blocked." or "Man ahead."
- R7. Full descriptive sentences with direction, e.g. "A man is walking towards you on your right; the footpath ahead is clear." Never single words.
- R8. **Distance and depth are measured internally and used to guide correctly, but are never spoken as numbers.** Allowed proximity words: "right in front of you", "within reach", "a few steps ahead", "further ahead".
- R9. Interactive: the user can speak at any time to interrupt, ask a follow-up, or change mode.
- R10. Camera choice: back (default) or front, switchable by voice later ("switch camera").
- R11. It must be a real product, not a demo. Behaviour must hold up in the user's three test places: office, home, street with moderate traffic.

## 3. Evidence-based rules (from the research)
- E1. Structure every description as overview → what matters → what to do.
- E2. Be brief by default; give more on request ("tell me more").
- E3. Directions are **computed by our code** from the image (left / slightly left / ahead / slightly right / right, or clock positions). The model's own direction words are never trusted.
- E4. Never invent. Say "I'm not sure" or "I can't read that, move the phone a little closer". Read numbers and doses exactly, or decline.
- E5. Don't flip a correct answer when the user pushes back. Re-check the frame instead.
- E6. No generic "be careful" lines, no cheerleading, neutral tone.
- E7. Never ask the user to "look" or "ask someone".
- E8. Never say it is safe to cross a road.
- E9. Proactive alerts only for confirmed hazards or for the target the user is looking for.

## 4. Why the field test failed → fixes (each must be verified)
| Symptom | Cause | Fix |
|---|---|---|
| "Step ahead" when there was none | One-frame jump in relative depth, low threshold, top priority | F1. A step is only a *candidate* until it persists over ≥3 depth frames at a consistent position. It is then **confirmed by Gemini** (does the walking path ahead have a step, kerb or drop within a few steps?) before anything is spoken. Unconfirmed candidates are silent. |
| "Blocked ahead" everywhere indoors | 3 m centre-lane rule + fake distances for unknown objects | F2. The local layer never speaks path status. Path status (open / narrowing / blocked + which side is open) goes to the narrator as context and is phrased in full sentences. "Blocked" is spoken only when the user is walking and something is within reach directly ahead, confirmed over ≥3 frames. |
| "Person / car coming towards you" while they were still | No ego-motion compensation | F3. Detect whether the user is walking (phone motion sensors, step cadence). While walking, "coming towards you" requires a closing speed clearly above walking pace, or sideways motion. Parked cars and standing people are never "coming towards you". |
| Place intro cut off / missing | Local alerts start at top priority before the place is known | F4. Start-up order: greeting → camera → orientation description (nothing may interrupt it except an *imminent, confirmed* collision) → then narration and alerts. |
| Choppy single words | Local templates spoken directly | F5. Local events become context for the narrator ("a person passed on the left 3 s ago"). Only imminent-danger alerts are spoken locally, and they are full short sentences: "Stop. A car is coming from your left." |

## 5. Architecture

### 5.1 Voice engine (one interface, two implementations)
`VoiceEngine` has `speak(text, priority)`, `interrupt()`, `onUserIntent(callback)` and `connect()/close()`.
- **LiveVoice (primary).** Gemini Live (`gemini-live-2.5-flash-native-audio` on Vertex `us-central1`, **relayed through our Cloud Run server at `/api/live`** — the server owns the setup message: model, system instruction, tools; the client cannot change them).
  - **Audio-only session; no continuous video is streamed.** All seeing is done by our vision tools. This means more accurate high-resolution analysis, sessions of about 15 minutes instead of 2, and much lower cost.
  - The user's speech goes to Live, which turns it into an **intent via function calling** (tools in 5.3).
  - Speech the app needs to say (narration updates, tool results) is sent as `[SAY] <text>`. The system instruction tells Live to speak exactly that.
  - Own mic capture (AudioWorklet → 16 kHz PCM) and own playback queue (24 kHz PCM), so hazards can **cut Live audio instantly**. The SDK's `startAudioConversation` only offers `stop()`.
  - Context-window compression (sliding window) plus session resumption on `goAway` keep long walks alive.
- **ClassicVoice (fallback).** Browser speech recognition (push-to-talk) plus a keyword intent parser, plus **Google Cloud Text-to-Speech (Chirp 3 HD)** via `POST /api/tts`, falling back to device text-to-speech when offline. Used automatically if Live can't connect. Same tools, same narration.

### 5.2 Vision service (server, Cloud Run): new `POST /api/scene`
- Model: `gemini-3.8-flash` (fallback `gemini-3.5-flash`), structured JSON output, high-resolution frame (up to 1024 px).
- Request: `{ frame, task: 'orient' | 'update' | 'find' | 'read' | 'ask' | 'verify_step', query?, previous?: SceneMemory, localEvents?: LocalEvent[], motion: { walking: boolean } }`.
- Model returns:
  - `objects[]`: `{ id, label, box_2d [ymin,xmin,ymax,xmax 0-1000], moving, heading: 'towards'|'away'|'crossing_left'|'crossing_right'|'static'|'unknown', hazard }`
  - `place`: `{ environment, category, specific, traffic: 'none'|'light'|'moderate'|'heavy' }`
  - `path`: `{ status: 'clear'|'narrowing'|'blocked'|'unknown', surface, open_side }`
  - `text`: string[]
  - `say`: speech **with placeholders** `{dir:<id>}` and `{near:<id>}`. The model never writes direction words itself.
- The server then:
  - computes each object's **body-relative direction** (5 sectors or clock position) from `box_2d`, camera field of view and front-camera mirroring;
  - computes **proximity** (from box size and base position, fused with the client's depth estimate when supplied) into the words "right in front of you", "within reach", "a few steps ahead" or "further ahead";
  - fills the placeholders and returns `{ say, facts }`.
- Unit-tested: geometry, placeholder filling, JSON validation and clamping.
- `/api/describe` and `/api/place` remain until the new flow replaces them, then are removed.

### 5.3 Assistant tools (function-calling declarations for Live; same functions in Classic)
`where_am_i()`, `start_narration()`, `stop_narration()`, `find_object(name)`, `stop_finding()`, `read_text()`, `describe_now()`, `ask_about_view(question)`, `take_me_to(place)` (Section 2: honest "coming soon"), `switch_camera(which)`, `repeat_last()`, `more_detail()`, `less_detail()`, `help()`.

### 5.4 Narration scheduler (client)
- Orientation first (`task: 'orient'`), then a tick every **6 s** (setting 4–10 s) with `task: 'update'` plus `previous` (a compact memory of the last facts) plus the local events since the last tick.
- Update content priority: (1) confirmed hazard, (2) moving people, animals and vehicles and what they are doing, (3) change of place or path, (4) path status.
- If nothing changed: a short varied path line at most every other tick ("Still a clear corridor, desks continue on your left."). Never the identical sentence twice in a row.
- A tick is skipped if the previous speech is still playing, or if the user is talking.

### 5.5 Find mode (client loop)
- First pass with `task: 'find'`. If found: "Your goggles are on the table, slightly to your right, within reach."
- Then re-check every ~2 s with short guidance ("now straight ahead", "a little lower") until the user says "got it", or after 60 s.
- If not found: guided scan ("I can't see them yet. Slowly turn to your right.").

### 5.6 Local safety layer (rewritten to be quiet and correct)
- MediaPipe EfficientDet replaces COCO-SSD later in this section (task S2-8). Tracking stays.
- Motion state from `DeviceMotionEvent` (step detection → walking or still). iOS needs a permission tap, which happens at Start.
- **Spoken locally only:** imminent collision (confirmed over ≥4 frames, consistent time-to-contact, ego-motion compensated) and Gemini-confirmed steps or drops.
- Everything else is context for narration.
- Hazard speech cuts current speech, plays an earcon, then speaks a full short sentence.

## 6. Start-up sequence (exact)
1. The user taps Start, the only tap needed. This unlocks audio and asks for mic and motion permissions.
2. "Hi, I'm your eye assistant. Which camera should I use, back or front?" No answer within 8 s → back.
3. The camera opens: "Using the back camera."
4. Orientation runs automatically: "You're in an office. Rows of desks on both sides; the walkway ahead is clear."
5. "Eye assistant is ready. You can say: where am I, find something, describe around me, read text, or take me somewhere."
6. The assistant waits for a command. The safety layer is armed after step 4 completes.

## 7. Costs and limits
- Live is audio-only, which keeps the cost per minute low. Vision calls happen about every 6 s while narrating, and on demand otherwise.
- Existing per-device rate limit and max 3 Cloud Run instances. A Live session cap (e.g. 20 min, then a polite reconnect).

## 8. Acceptance tests (field, by the user; matches the 2026-10-09 failures)
- A1 Office: the first utterance is the place description, fully spoken. No "step" or "blocked" at a normal desk aisle. Within 60 s of narrating there are at least 4 useful updates and no identical repeats.
- A2 Home: as A1, plus "find my <object>" finds an object on a table with the correct left/right.
- A3 Street, moderate traffic: walking past parked cars produces no "coming towards you". A car actually approaching is described with its direction. Traffic level is reported in "where am I".
- A4 Interrupt: speaking while it narrates stops it within 1 s and the question is answered.
- A5 Fallback: with Live disabled, the same flows work through ClassicVoice.

## 9. Out of scope for Section 2 (later sections)
Turn-by-turn navigation (Section 3), SOS (Section 4), onboarding profile with cane/dog and colour preference (backlog), languages other than English (setting exists; tested later).

## 10. Open risks
- **Live probe results (2026-10-09):**
  - Vertex Live direct WebSocket with ADC: `us-central1` ✅ ("ready" + audio, ~3.3 s incl. connect). `asia-south1` ❌ and `asia-southeast1` ❌ (model not published there).
  - Firebase AI Logic Live (web SDK 13.0.0, AgentPlatformBackend, any region): ❌ "Firebase AI Logic genai config not found", even after the console Get-started. Non-Live `generateContent` via AI Logic Agent Platform `global` ✅.
  - ⇒ Client-direct Live through Firebase is not usable now. **DECIDED (user, 2026-10-09): relay Live through our Cloud Run server** (WebSocket, service account, guard at connect, upstream `us-central1`). Phone connects straight to the Cloud Run URL (Firebase Hosting cannot proxy WebSockets).
  - **DECIDED: fallback voice = Google Cloud Text-to-Speech (Chirp 3 HD) for output + browser SpeechRecognition (Google engine on Chrome) for input**; device TTS only as offline last resort for hazard alerts.
- Our project's access to the Live model on Vertex is **unverified**: the first probe failed with "Firebase AI Logic genai config not found", which needs a console setup click. If Live is unavailable after that, ClassicVoice becomes the primary engine and Live is retried later.
- Live paraphrasing `[SAY]` text: mitigated by the system instruction, and verified in testing.
- iOS Safari: AudioWorklet and motion permission must be tested on a real iPhone.
