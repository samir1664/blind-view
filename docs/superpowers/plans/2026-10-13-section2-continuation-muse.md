# Section 2 Continuation — Muse Plan (source of truth for implementation)

Created: 2026-10-13. Author: Muse + Samir. Previous work: MS Copilot (hit token limit, switched to Muse).
Read with: `docs/superpowers/specs/2026-10-08-hackathon-roadmap.md`, `docs/superpowers/specs/2026-10-09-section2-eye-assistant-design.md`, `docs/superpowers/plans/2026-10-09-section2-eye-assistant.md`.

## 1. Goal: win the hackathon with a real product
- Blind View: voice-first eye assistant for blind / low-vision users. Phone camera -> spoken guidance while walking. PWA. Disclaimer: does not replace cane / guide dog.
- Aim is a real product, not a dummy POC. Must hold up in office, home, street (moderate traffic).
- Hackathon: AI Builder Cup 2026, Hack2skill + Google Cloud, JAPAC. Theme: Sustainability & Social Impact. Category: Accessibility.
- Official site (aibuildercup.com): Prototype building 7 Sept - 18 Oct 2026. Prototype deadline 18 Oct 2026. Evaluation 19 Oct - 6 Nov. Finalists 7 Nov. Demo Day Singapore 4 Dec. Prize pool $30,000 total.
- Judging (from roadmap): 40% Technical merit & meaningful GenAI, 25% Problem alignment & impact, 25% Innovation, 10% UX. Side prizes: Best use of Google Cloud AI, Most Impactful, Social Choice, Best UI/UX.
- Submission: working deployed link, public GitHub repo, demo video <3 min, deck as PDF. All in English.
- Mandatory: Gemini/Gemma + deployed on Google Cloud via Cloud Run or Firebase. Live URL: https://blind-view-ai.web.app. GCP project: blind-view-ai.
- Win strategy: (a) demo must work first-try on judge's phone, (b) show meaningful GenAI (Live + vision + geometry), not a wrapper, (c) show real impact (research-backed, tested with blind-user needs), (d) clean UX (one tap Start, voice-only), (e) stable deployed link, never break judged URL — use preview tags for tests.

## 2. Locked user decisions (2026-10-13, Muse)
- D1 Narration mode = Regular updates (option b). Short update every few seconds even if nothing changed, but NOT irritating. Updates like: person passed, pause, nothing ahead, way is clear, current view, what is changing, moving objects. Never identical repeats. Never bare words ("Blocked.", "Man ahead.").
- D2 Depth / distance = MEASURE accurately internally, NEVER speak numbers. No exact metres, no depth numbers. Use only proximity words: "right in front of you", "within reach", "a few steps ahead", "further ahead". Depth/distance exists only to guide correctly (which side is open, when to stop, step/kerb warnings).
- D3 Work style = low-token. One task at a time, one small diff per turn, short summaries, no full file dumps. Use superpowers workflow: this plan + specs are source of truth, checkboxes for tracking.
- D4 One section at a time. Do not dump everything. Simple language.
- D5 Previous decisions still hold: Approach A live-first hybrid, one account/project/env, Vertex AI (not AI Studio key), English demo, Android Chrome + iPhone Safari.

## 3. How it works today (two brains)
- Fast brain (on phone, ~8 fps, works offline): COCO-SSD detector (detector.ts), spatial (spatial.ts, left/ahead/right + rough distance from size), tracker (tracking.ts, approach + time-to-contact), hazards (hazards.ts, car 1.0 / person 0.5 / backpack 0.25), depth/terrain (depth.ts, terrain.ts, Depth Anything, ~1 fps), freespace (freespace.ts, blocked + open side), director (director.ts, one voice, interrupt rules, no repeat ~5s), audio (AudioEngine.ts, earcons.ts, Hazard > Alert > Narration > Info).
- Smart brain (cloud, every few seconds, needs internet): server apps/server sits between phone and Gemini (key never on phone). Endpoints: GET /api/health, POST /api/describe, POST /api/place, POST /api/scene (Section 2), /api/live (Section 2), POST /api/tts (Section 2 fallback). Modes: guide, scene, text, find, currency, ask. Place awareness: 15 types + playbooks (place.ts, playbooks.ts). Example: Road = never say safe to cross; Station = platform edge first; Mall = escalator up/down; Home = heights.
- Main loop: useEngine.ts. Screens: Disclaimer, App (Start/Stop + Describe / Read / Money / Ask), voice commands (recognition.ts), Settings (SettingsPanel.tsx, saved on phone).
- Protections: exponential backoff (3s/6s/12s...2min, tell once), rate limit 60/min/device, backup models, keyframe check (dark/blurry), input validation, drop warnings >~2s old.

## 4. Current stage (verified from docs + code listing 2026-10-13)
- Section 1 Cloud Foundation: DONE. Vertex provider, guard (App Check + anon Auth), Firebase web, Dockerfile + Cloud Run blind-view-api asia-south1, Hosting rewrite, budget alerts. Confirmed working on Vivo V20 Pro (Android Chrome).
- Section 2 Eye Assistant: Spec written. Plan marks S2-2 (/api/scene) and S2-3 (Live relay) DONE. MUST VERIFY before building on them (Step 0 below).
- Older plain-language guide said "no tests, no deployment" — OUTDATED. Section 1 deployment exists. Do not trust that guide for status.

## 5. Field-test failures (2026-10-09) -> fixes — MUST NOT REGRESS
| Heard | Cause | Fix (spec F1-F5) |
|---|---|---|
| "Step ahead" false | 1-frame depth jump, threshold 0.055, top priority | F1: candidate persists >=3 depth frames at consistent position, then Gemini verify_step confirms before speaking. Unconfirmed = silent. |
| "Blocked ahead" indoors | 3m centre-lane + fake distance (area x 40) | F2: local layer never speaks path status. Path -> narrator as context, full sentences. "Blocked" only if walking + within reach directly ahead, confirmed >=3 frames. |
| "Person/car coming towards you" when still | No ego-motion comp; walking forward makes static objects approach | F3: walking detection (motion sensors / step cadence). While walking, "coming towards" needs closing speed clearly above walking pace, or sideways motion. Parked / standing never "coming towards". |
| Place intro cut off / missing | Local alerts at top priority before place known | F4: Startup order: greeting -> camera -> orientation (nothing interrupts except imminent confirmed collision) -> narration + alerts. |
| Choppy single words | Local templates spoken directly | F5: Local events -> context for narrator. Only imminent-danger spoken locally, full short sentences: "Stop. A car is coming from your left." |

## 6. What user wants now (Section 2 requirements R1-R11 + E1-E9)
- R1 Greeting: "Hi, I am your eye assistant. Which camera should I use, back or front?" Then open that camera.
- R2 Then: "Eye assistant is ready. What would you like?" + offer options.
- R3 Take me to <place> (barber, bakery, medical shop). Section 2: recognise intent, answer honestly "Navigation is coming soon, I can tell you what's around you now". Full navigation = Section 3.
- R4 Where am I? Place type + situation: home, office, shop, street light/moderate/heavy traffic, park/forest, closed room.
- R5 Find <object> (goggles, purse, shoes): say where with direction, guide hand/steps until reached. If not visible, say how to turn.
- R6 Narrate live scene. FIRST utterance = place + overall situation. Then regular short updates (D1). Content priority: (1) confirmed hazard, (2) moving people/animals/vehicles + what they do, (3) change of place/path, (4) path status. If nothing changed: short varied path line at most every other tick. Never identical twice.
- R7 Full descriptive sentences with direction. Example: "A man is walking towards you on your right; the footpath ahead is clear." Never single words.
- R8 Depth/distance internal only (D2). Never speak numbers.
- R9 Interactive: user can speak any time to interrupt, follow-up, change mode. Interrupt within 1s (A4).
- R10 Camera: back default, front switchable by voice ("switch camera"). Front camera mirroring must be correct in geometry.
- R11 Real product: holds up in office, home, street moderate traffic.
- E1 Structure: overview -> what matters -> what to do. E2 Brief by default, more on request ("tell me more"). E3 Directions computed by OUR code from image (left/slightly left/ahead/slightly right/right or clock). Never trust model direction words. E4 Never invent. Say "I'm not sure" / "I can't read that, move phone closer". Read numbers/doses exactly or decline. E5 Don't flip correct answer on pushback; re-check frame. E6 No generic "be careful", no cheerleading, neutral tone. E7 Never ask user to "look" or "ask someone". E8 Never say safe to cross road. E9 Proactive alerts only for confirmed hazards or sought target.
- Research (10 sources, roadmap): WHO 2.2B vision impairment; India ~4.8M blind, ~74M visually impaired; skew older, less literate -> voice-first, zero text. 66% use at home (object ID 21.5%, reading 13.8%). 22% follow-ups had false info, text reading 34.6% errors. Users want proactive goal-tied alerts; hate no spatial memory, wrong directions, sycophancy, cheerleading, being told to look/ask. Describe new scene first (pro guides). Store ability profile. Navigation: one-line overview -> obstacles -> steps; clock directions valued but models confuse frames -> compute ourselves.

## 7. Section 2 architecture (must implement)
- 7.1 VoiceEngine: speak(text, priority), interrupt(), onUserIntent(), connect()/close(). Two impls:
  - LiveVoice (primary): Gemini Live gemini-live-2.5-flash-native-audio on Vertex us-central1, RELAYED via Cloud Run /api/live. Server owns setup (model, system instruction, tools). Client cannot change them. Audio-only session, no continuous video. Seeing via vision tools only. User speech -> intent via function calling. App speech sent as [SAY] <text>, Live speaks exactly that. Own mic (AudioWorklet 16kHz PCM) + own playback queue (24kHz PCM) so hazards cut Live instantly. Sliding-window compression + resumption on goAway.
  - ClassicVoice (fallback): browser STT (push-to-talk) + keyword parser + Google Cloud TTS Chirp 3 HD via POST /api/tts, fallback device TTS when offline. Same tools, same narration. Auto-switch if Live fails.
- 7.2 Vision /api/scene (server): gemini-3.8-flash (fallback 3.5-flash), structured JSON, high-res frame up to 1024px. Request: {frame, task: orient|update|find|read|ask|verify_step, query?, previous?: SceneMemory, localEvents?, motion:{walking}}. Returns objects[] {id, label, box_2d [ymin,xmin,ymax,xmax 0-1000], moving, heading, hazard}, place {environment, category, specific, traffic none|light|moderate|heavy}, path {status clear|narrowing|blocked|unknown, surface, open_side}, text[], say with placeholders {dir:<id>} {near:<id>}. Server computes body-relative direction (5 sectors / clock) from box_2d + FOV + mirroring, proximity words from box size/base + depth fusion, fills placeholders, returns {say, facts}. Unit-tested geometry, placeholder fill, JSON validate/clamp. /api/describe + /api/place remain until new flow replaces them, then remove.
- 7.3 Tools (function-calling for Live; same in Classic): where_am_i(), start_narration(), stop_narration(), find_object(name), stop_finding(), read_text(), describe_now(), ask_about_view(q), take_me_to(place) (Section 2: honest coming-soon), switch_camera(which), repeat_last(), more_detail(), less_detail(), help().
- 7.4 Narration scheduler (client): Orientation first (orient), then tick every 6s (setting 4-10s) with update + previous + localEvents. Priority per S6-R6. Skip tick if previous speech still playing or user talking.
- 7.5 Find mode: first pass find. If found: "Your goggles are on the table, slightly to your right, within reach." Re-check ~2s with short guidance until "got it" or 60s. If not found: guided scan ("I can't see them yet. Slowly turn to your right.").
- 7.6 Local safety layer (quiet + correct): MediaPipe EfficientDet replaces COCO-SSD later in section (S2-8). Tracking stays. Motion from DeviceMotionEvent (step detection -> walking/still). iOS needs permission tap at Start. Spoken locally ONLY: imminent collision (confirmed >=4 frames, consistent time-to-contact, ego-motion compensated) + Gemini-confirmed steps/drops. Else context for narration. Hazard speech cuts current speech, earcon, then full short sentence.
- 7.7 Startup sequence (exact): 1) Tap Start (only tap, unlocks audio, asks mic + motion). 2) "Hi, I'm your eye assistant. Which camera should I use, back or front?" No answer 8s -> back. 3) Camera opens: "Using the back camera." 4) Orientation auto: "You're in an office. Rows of desks on both sides; the walkway ahead is clear." 5) "Eye assistant is ready. You can say: where am I, find something, describe around me, read text, or take me somewhere." 6) Wait for command. Safety armed after step 4.
- 7.8 Costs/limits: Live audio-only keeps cost low. Vision ~every 6s while narrating, on-demand otherwise. Per-device rate limit + max 3 Cloud Run. Live session cap ~20 min, polite reconnect.

## 8. Implementation tasks (checkboxes — do in order, one at a time)
- [x] Step 0 VERIFY (2026-10-13): S2-2 / S2-3 files exist + match spec headers (geometry, scene, live, LiveVoice, audio-io). Gaps fixed in Fix log below. S2-4/S2-5 also existed, needed isPlaying + tool_cancel fixes.
- [x] S2-1 Scene geometry (server) — VERIFIED, no churn (wording slightly to your left vs slightly left left as-is). scene.test.ts exists.
- [x] S2-2 /api/scene (server) — VERIFIED, no churn. parse/validate/clamp + speechFor present.
- [x] S2-3 Live relay (server) — FIXED 2026-10-13: added missing help() to LIVE_TOOL_NAMES + declaration + system-instruction mapping. Other 13 tools unchanged.
- [x] S2-4 Audio I/O (web) — FIXED 2026-10-13: Player.isPlaying() now real (playingUntil = enqueue duration, cleared on flush/idle). S1 firebase.json /@(models|ort)/** Cache-Control now `public, max-age=2592000, immutable`.
- [x] S2-5 Live voice client (web) — FIXED 2026-10-13: handle() now handles server tool_cancel (interrupt, drop pending turn, no crash). Previously dropped.
- [x] S2-6 Assistant controller (web) — CREATED 2026-10-13: lib/assistant/controller.ts, narration.ts, find.ts, tools.ts, narration.test.ts. Startup greeting -> 8s camera choice -> orientation -> ready. 14 tools incl help. 6s scheduler (D1), skip if speaking/talking, no repeats. Find 2s/60s + scan. Wired into useEngine (startAssistant/stopAssistant, old loop kept as fallback).
- [x] S2-7 Quiet safety layer (web) — REWRITTEN 2026-10-13: motion.ts (step cadence). tracking.ts ego-gate (walking needs closing > walking+0.6). terrain.ts StepCandidateTracker ≥3 frames, phrase silenced, verify_step via controller. freespace.ts fake (w*h)*40 removed, phrase silenced. director.ts imminent-only local speech, else context via takeContext(). simulate-guide.ts + Scenario 4 (parked car silent) + Scenario 5 (static desk silent). PARTIAL: useEngine does not yet auto-call verify_step or feed director context into /api/scene localEvents — controller does fetch localEvents via getLocalEvents (currently empty); wire in next pass.
- [x] S2-8 MediaPipe EfficientDet (web) — REPLACED 2026-10-13: detector.ts now @mediapipe/tasks-vision ObjectDetector (EfficientDet-Lite0, same loadDetector/detectFrame interface). vite.config.ts mediapipe chunk + CDN wasm cache. setup-assets.mjs downloads efficientdet-lite0.tflite + copies tasks-vision wasm. package.json: TFJS removed, tasks-vision added. useEngine type updated to DetectorModel. NEEDS: npm install + npm run dev (model file ~4MB downloads on setup).
- [x] S2-9 UI (web) — UPDATED 2026-10-13: App.tsx adds Voice menu (Where am I / Narrate / Find goggles / Take me to / Help / Eye Assistant) wired to controller.runToolAndSpeak. Start/Stop kept. Status role=status kept. styles.css .actions wrap + 64px targets.
- [x] S2-10 Fallback voice — CREATED 2026-10-13: server tts.ts (Chirp 3 HD) + POST /api/tts (guard + rate-limit). web ClassicVoice.ts (browser STT keyword parser + /api/tts, device TTS offline last resort). Auto-switch: useEngine startAssistant tries Live, falls back to Classic on failure. NEEDS: enable texttospeech.googleapis.com in GCP console + test.
- [ ] S2-11 Deploy + field acceptance: deploy API (preview tag first) + web; user runs A1-A5 in office/home/street; fix findings. Never break judged URL.

## 9. Acceptance tests (field, by user)
- [ ] A1 Office: first utterance = place description, fully spoken. No "step"/"blocked" at normal desk aisle. Within 60s narrating: >=4 useful updates, no identical repeats.
- [ ] A2 Home: as A1, plus "find my <object>" finds object on table with correct left/right.
- [ ] A3 Street moderate traffic: walking past parked cars -> NO "coming towards you". Real approaching car described with direction. Traffic level reported in "where am I".
- [ ] A4 Interrupt: speaking while narrating stops it within 1s, question answered.
- [ ] A5 Fallback: with Live disabled, same flows work via ClassicVoice.
- [ ] Demo check (win): judge opens link on Android Chrome + iPhone Safari, taps Start, hears greeting -> camera -> orientation -> ready, asks "where am I" + "narrate", gets full sentences, no false alarms in 2 min demo.

## 10. Out of scope for Section 2 (later)
- Section 3: Take me to — walking navigation (Maps Places/Routes + ADK agent) + last-metres camera guidance.
- Section 4: SOS / caregiver live map (Firestore + Maps).
- Section 5: Hardening, video, deck, submission.
- Backlog: onboarding profile (cane/dog, colour pref), languages other than English (setting exists, tested later).

## 11. Open risks / decisions to re-check
- Live model access on Vertex unverified for production? First probe needed console setup. If Live unavailable, ClassicVoice becomes primary, Live retried later.
- Live paraphrasing [SAY]: mitigate via system instruction, verify in testing.
- iOS Safari: AudioWorklet + motion permission must test on real iPhone.
- Vertex Live only gemini-live-2.5-flash-native-audio (stable), only us-central1 (not global). No Live 3.x on Vertex. App Check enforcement mandatory for Firebase AI Logic from 2 Nov 2026 (during judging).
- Gemini 2.5 non-Live models on Vertex shut down Oct 2026 — do not use them.
- Costs: keep Live audio-only, vision ~6s, rate limits, max 3 instances, session cap. Upgrade trial to Paid billing ~15-17 Oct (keeps credit; trial stops resources when credit/90d out).

## 12. Working rules (low-token, superpowers)
- This file is source of truth for Section 2 continuation. Update checkboxes here, do not rewrite docs.
- One task at a time. One small diff per turn. Short summaries: what changed, what to test, what is next.
- Never speak distances/depth as numbers (D2). Directions only from server geometry (E3).
- All paid endpoints + WebSocket require Section 1 guard when REQUIRE_APP_CHECK=true.
- English only in this section. Front-camera mirroring correct.
- Test preview tags before touching judged URL.

## 13. Fix log 2026-10-13 (Muse, low-token pass)
- firebase.json: /@(models|ort)/** Cache-Control += `, immutable`.
- apps/server/src/liveProtocol.ts: + help tool (14 total), declaration + system mapping.
- apps/web/src/lib/live/audio-io.ts: isPlaying() real via playingUntil (enqueue duration, flush/idle clear).
- apps/web/src/lib/live/LiveVoice.ts: handle tool_cancel (interrupt, drop turn, no crash).
- apps/web/src/lib/assistant/narration.ts, find.ts, tools.ts, controller.ts (NEW): startup, 14 tools, 6s scheduler D1, find 2s/60s.
- apps/web/src/lib/assistant/narration.test.ts (NEW): dedupe/skip/idle/pickUpdate.
- apps/web/src/hooks/useEngine.ts: assistant wiring (startAssistant Live->Classic fallback, stopAssistant, DetectorModel type), old loop kept.
- apps/web/src/lib/vision/motion.ts (NEW): step-cadence walking detection.
- apps/web/src/lib/vision/tracking.ts: ego-gate for approaching.
- apps/web/src/lib/vision/terrain.ts: StepCandidateTracker ≥3 frames, step/path phrase silenced.
- apps/web/src/lib/vision/freespace.ts: fake distance removed, phrase silenced.
- apps/web/src/lib/narration/director.ts: imminent-only local speech, else context via takeContext().
- apps/web/scripts/simulate-guide.ts: + Scenario 4 parked-car silent, Scenario 5 static-desk silent.
- apps/server/src/tts.ts (NEW) + POST /api/tts in index.ts (guard + rate-limit).
- apps/web/src/lib/assistant/ClassicVoice.ts (NEW): STT keyword parser + /api/tts + device TTS fallback.
- apps/web/src/lib/vision/detector.ts: MediaPipe EfficientDet replaces COCO-SSD/TFJS. vite.config.ts, setup-assets.mjs, package.json updated. Model: public/models/efficientdet-lite0.tflite.
- apps/web/src/App.tsx + styles.css: voice-menu buttons, 64px targets, role=status kept.
- NOT changed: S2-1/S2-2 wording, imageBase64 name, Section 1 guard/deploy logic.
- PARTIAL / Samir must test: (1) `npm install` (tasks-vision), (2) `npm run dev` + `npm test` (web + server), (3) `npm run typecheck`, (4) `npx tsx apps/web/scripts/simulate-guide.ts` — expect Scenario 4/5 PASS silent, (5) enable texttospeech.googleapis.com, (6) field A1-A5: office/home/street/interrupt/fallback, (7) deploy preview tag first, never break judged URL.
- RISKS: MediaPipe model/WASM download needs network on first setup; ClassicVoice STT needs Chrome; verify_step auto-wiring + director context -> /api/scene localEvents still to wire in useEngine next pass.

## 14. Language / voice root fix 2026-10-14 (Muse)
- ROOT CAUSE: no language setting anywhere; voice picker chose by macOS-only voice *names* (Samantha/Alex/...), never set utterance.lang; voices load async but unlock() never waited; saved voice URI from another device could strand speech; silent-streak only reported death, never switched to cloud. Result: on a judge's device / non-English system, app could go totally silent.
- FIX: settings.language = 'system' (default follows navigator.language). New lib/audio/voice.ts: resolveSpeechLanguage() + pickVoice() (exact locale -> prefix -> any English -> any usable; saved URI ignored when missing on this device; novelty voices never auto-picked) + voice.test.ts (exact/prefix/fallback/missing-saved/novelty). AudioEngine: setLanguage/getResolvedLanguage, waitForVoices() awaited in unlock(), utterance.lang always set, resolveVoice language-aware, Cloud TTS fallback in speakViaCloud() (POST /api/tts {text, language}, MP3 playback, same queue) when: no usable voice, device speech dead, device error, or silent timeout. stopAll/cancelCurrent also stop cloud audio. Server tts.ts: accepts languageCode (English -> Chirp Aoede; other languages -> languageCode only, Google picks default voice). ClassicVoice: STT lang + /api/tts language + device utterance lang all resolved. recognition.listenOnce: default 'system', not hardcoded en-US. useEngine: applies language on mount + on settings change + on Start. SettingsPanel: Language dropdown (System default (detected: X) + EN/HI/ES/FR/DE) + "No <lang> voice on this device — will use cloud voice" warning.
- NOT changed: narration logic, distances (never spoken as numbers), Section 1 guard/deploy, tsconfig.
- SAMIR MUST TEST: `npm run typecheck`, `npm test` (incl. voice.test.ts), `npm run dev`. Judge scenario: fresh browser profile (no saved voice) + system language hi-IN / en-IN -> Start must still speak (device voice or cloud). Airplane/offline + dead device speech -> text stays on screen + error, never unexplained silence. Also test Settings language switch + Test voice button.

## 15. Firestore feedback 2026-10-14 (Muse) — submission requirement, honest use
- WHY: submission brief must describe Firebase + Firestore + Cloud Run + Gemini. App used Firebase (Auth, App Check, Hosting) but had NO Firestore. No Firestore use is claimed until this feature ships.
- FEATURE: anonymous "Was this description helpful? Yes / No" buttons under Spoken history (show only after something was spoken). POST /api/feedback { helpful, placeCategory } via existing authHeaders(). No PII, no text input.
- SERVER: apps/server/src/feedback.ts (NEW: validateFeedbackBody pure + storeFeedback via firebase-admin/firestore, collection `feedback`, fields helpful/placeCategory/appVersion/createdAt server timestamp, returns false never throws) + POST /api/feedback in index.ts (same guard + rate limit as /api/scene; valid body always 200 { stored }). Firestore DB must exist in Firebase project (Console → Build → Firestore Database → Create, production mode, asia-south1) or writes degrade to { stored:false }.
- WEB: apps/web/src/components/FeedbackButtons.tsx (NEW) rendered in App.tsx under Transcript. Fire-and-forget; never interrupts narration/speech.
- TEST: apps/server/src/feedback.test.ts (NEW: validation only, never writes to real Firestore).
- SAMIR MUST: (1) create Firestore DB in Console, (2) `npm run typecheck` + `npm test`, (3) `npm run dev`, Start, tap Yes/No, check Firestore Console for a doc in `feedback`, (4) redeploy API preview then prod, (5) do NOT claim Firestore in deck/brief until the doc appears.

## 16. Optimization 2026-10-14 (Muse) — motion-aware narration + voice-first startup (gap vs Gemini app, Samir rated app 3/5)
- FIND NOT IN VIEW: controller ignored facts.found, so a guessed direction could be spoken. Now find.ts has pure decideFindTick(): found=true -> speak direction + stop; found=false + detector agrees -> speak once "I can't see your <object> yet. Move your camera slowly to the left" (alternates left/right on misses), never a guessed direction; found=false + detector disagrees -> "Hold steady..." (no direction claim); no verdict -> old behaviour. Controller passes detector labels (getDetections) + uses the decision. Find keeps re-checking each tick; Stop closes the assistant so Find cancels. Test: find.test.ts.
- MOTION-AWARE NARRATION: new StillnessGate in motion.ts (moving = narrate; still 6s = "How can I help?" once, then narration pauses, mic stays listening; movement = "You're moving again." + fresh narration). Motion = camera-frame change (own 64x48 scorer at 2 Hz, threshold 0.04) OR DeviceMotion steps (MotionTracker, iOS permission requested in the Start tap, any failure silently ignored — camera alone is enough). Wired in useEngine Tier 2 loop AND controller narrationTick (shared gate class). Never prompts during Find / Read / question (gate resets), never twice per still period, never when stopped. Test: motion.test.ts.
- VOICE-FIRST STARTUP: DELETED the Disclaimer blocking screen (Disclaimer.tsx removed, gate removed from App.tsx). New startup: whole screen is one giant Start/Stop toggle (tap anywhere; buttons/inputs/install card/transcript keep their own behaviour, taps during Starting ignored). First tap/keypress unlocks audio and speaks: safety line once on first launch only (localStorage blindview:disclaimerSpoken:v1, never a screen) + "Hello, this is Blind View. Tap anywhere to start. Tap again to stop." + install hint if not installed. Safety line still spoken; settings.disclaimerAcceptedAt kept unused (persist compat).
- PWA INSTALL: new InstallPrompt.tsx. Shows only in browser (hidden when display-mode standalone / iOS standalone, and after appinstalled). Android: beforeinstallprompt -> "Install app" button. iOS: 3 steps "Tap Share, then Add to Home Screen, then Open Blind View". Spoken: "Once it's on your Home Screen, you can say Hey Siri or Hey Google, open Blind View." Never claims voice assistants open a non-installed site. Dismissible via Skip, never blocks Start. Manifest verified already correct (name Blind View, display standalone, theme black, apple-mobile-web-app-title Blind View) — no change.
- NOT changed: API routes, server prompts, safety rules (silent unless imminent+confirmed), no numeric distances spoken, no identical repeats, deck/submission files.
- SAMIR MUST TEST ON PHONE: (1) Find goggles with goggles NOT in view -> move-camera prompt, alternate left/right; put goggles in view -> direction spoken. (2) Stand still 6s -> "How can I help?" once, narration pauses; walk -> "You're moving again." + narration resumes. (3) Fresh open -> no instruction screen; first tap speaks greeting; tap anywhere = Start/Stop. (4) Install card shows in browser, hides when installed; Skip hides it. Then `npm run typecheck` + `npm test` + deploy.
