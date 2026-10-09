# Blind View — AI Builder Cup Roadmap (source of truth)

Read this file first before starting any section or task.

## Hackathon facts (from aibuildercup.com, checked 2026-10-08)
- Organiser: Hack2skill, sponsored by Google Cloud. JAPAC region. Working professionals only (no students). Team of 2-4.
- Theme: **Sustainability & Social Impact**. Category to declare: **Accessibility**.
- Prototype deadline: **18 Oct 2026**. Evaluation 19 Oct - 6 Nov. Finalists 7 Nov. Demo Day Singapore 4 Dec.
- Mandatory: Gemini/Gemma (or Agent Platform / Antigravity / AI Studio) AND **deployed on Google Cloud via Cloud Run or Firebase**.
- Submission: working deployed link, public GitHub repo, demo video < 3 min (YouTube/Vimeo/Drive), deck as PDF. All in English.
- Fresh-project rule: building opened 7 Sept; our first commit is 16 Sept -> OK.
- Judging: 40% Technical merit & meaningful GenAI, 25% Problem alignment & impact, 25% Innovation, 10% UX.
- Side prizes: Best use of Google Cloud AI tools, Most Impactful, Social Choice, Best UI/UX.

## Locked decisions
- **GCP Project ID: `blind-view-ai`** (account samirmohmmad011@gmail.com, org 849085705344). Ignore "My First Project". Firebase added to it (2026-10-08).
- Billing account `01157F-128696-0D39B7` (INR). Budget ₹25,000/month, alerts 17/30/50/90%. Tools on Mac: firebase-tools 15.33.0 (npm -g), gcloud 588 in ~/google-cloud-sdk using Python 3.12 (CLOUDSDK_PYTHON in ~/.zshrc).
- **Approach A — Live-first hybrid.** Gemini Live companion with tools; on-device safety layer stays and can interrupt Live audio.
- **One Google account, one billing account, one project, one environment.** Test new versions on Cloud Run tagged revisions (`--no-traffic --tag`) so the judged URL never breaks.
- Use **Vertex AI** (not AI Studio key): the $300 trial credit does not cover AI Studio Gemini API usage. Removes the ~20 req/day free-tier cap.
- Upgrade the trial to a Paid billing account ~15-17 Oct (keeps remaining credit; trial accounts STOP all resources when credit/90 days run out).
- Budget alerts at $50 / $150 / $250. App-side caps (rate limit, Live session length, daily Live cap).
- Demo devices: **Android Chrome and iPhone Safari** -> nothing Android-only in the core (ARCore depth = stretch only).
- Demo language: **English**; language is a setting so others work.
- Features chosen: Live conversation, multilingual setting, SOS/caregiver via Firebase, navigation agent (ADK + Maps). Gemma offline: NOT chosen.
- User wants Google models for object detection, hazards, depth/distance (core product value).

## Live deployment
- **Public URL (submit this): https://blind-view-ai.web.app** (Firebase Hosting; `/api/**` rewrites to Cloud Run).
- Cloud Run: `blind-view-api`, asia-south1, https://blind-view-api-719445074518.asia-south1.run.app, SA `blind-view-api@blind-view-ai.iam.gserviceaccount.com` (roles/aiplatform.user only), max 3 instances, REQUIRE_APP_CHECK=true.
- Default compute SA `719445074518-compute@developer.gserviceaccount.com` was granted `roles/run.builder` (needed for `--source` deploys on new projects).
- Deploy: server → `npm run deploy:api`; test first with `npm run deploy:api:preview` (tagged, no traffic). Web → `npm run deploy:web`.
- Before each web deploy the bundle was scanned: debug token and API key value NOT present.

## Verified on our project (2026-10-08)
- Firebase Web App ID `1:719445074518:web:68791687067386d7ae91f7` ("Blind View Web"). Project number 719445074518.
- reCAPTCHA Enterprise score key `6LcmJ-UtAAAAACjcTNIT_rwcGRkq5sG-GAJLOSlR` (domains localhost, blind-view-ai.web.app, blind-view-ai.firebaseapp.com), registered in App Check (TTL 1h, min score 0.5).
- App Check debug token "samir-macbook-dev" lives only in local `.env` (VITE_APPCHECK_DEBUG_TOKEN).
- Anonymous auth must be enabled by clicking Authentication → Get started in console (API returns CONFIGURATION_NOT_FOUND before that).
- APIs enabled: aiplatform, run, cloudbuild, artifactregistry, firebaseappcheck, recaptchaenterprise, identitytoolkit, secretmanager, firestore.
- Vertex `global` generateContent returns 200 for: `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`, `gemini-3.8-flash` (thinkingLevel low OK).
- Model Garden also lists: `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-live-2.5-flash-native-audio`.
- Default `GEMINI_MODEL` for narration: `gemini-3.5-flash-lite,gemini-3.1-flash-lite`. Use `gemini-3.8-flash` for spatial/hazard boxes (Section 2).
- zsh gotcha: write `${M}:generateContent`, never `$M:...` (zsh `:g` modifier mangles it).

## Verified platform facts (Oct 2026 docs)
- Current models: Gemini 3.8 Flash; Flash-Lite family. Some Gemini 2.5 non-Live models on Vertex shut down Oct 2026 -> do not use them.
- Vertex Live: only `gemini-live-2.5-flash-native-audio` (stable). Not available in `global` location. No Live 3.x on Vertex.
- Firebase AI Logic web SDK supports Live with the Vertex backend (client-direct, no secret). Preview.
- **App Check enforcement is mandatory for Firebase AI Logic from 2 Nov 2026** (during judging).
- Gemini Robotics-ER 2 (`gemini-robotics-er-2-preview`): spatial points/boxes; needs restricted API key; privacy notice about identifiable persons -> not primary for street use.
- Gemini Flash returns `box_2d` [ymin,xmin,ymax,xmax] 0-1000 for open-vocabulary detection.
- MediaPipe Object Detector (web): EfficientDet-Lite0 ~28 ms GPU on Pixel 6; COCO 80 classes.
- WebXR depth (ARCore) needs an immersive-ar session that takes over the camera -> stretch only.

## Sections (one at a time; discuss the next only after the previous is done)
| # | Section | Status |
|---|---|---|
| 1 | Cloud foundation: GCP+Firebase project, Vertex AI, App Check + anon Auth, Cloud Run, Firebase Hosting, budget | **DONE 2026-10-09 — user confirmed working on Vivo V20 Pro (Android Chrome)** |
| 2 | **Eye Assistant**: voice-first flow, where am I, find object, narrate (orient-first, regular updates), read text, quiet+correct safety layer, MediaPipe. Spec: `2026-10-09-section2-eye-assistant-design.md` | **Spec written — blocked on Firebase AI Logic console setup for Live probe** |
| 3 | Take me to: walking navigation (Maps Places/Routes + ADK agent) + last-metres camera guidance | Not discussed |
| 4 | SOS / caregiver live map (Firestore + Maps) | Not discussed |
| 5 | Hardening, video, deck, submission | Not discussed |

## Field test 2026-10-09 (user, Vivo V20 Pro) — problems to fix
- Office: place intro started then got cut off by "person ahead, keep left, step ahead (false), blocked ahead".
- Home: no place intro; starts with "blocked ahead", "person coming to you", "step ahead", "blocked".
- Street (moderate traffic): "you are outdoor, car coming towards you, be right".
- Verdict: narration poor, object detection bad, style = choppy single words.

## User's requested experience (2026-10-09)
1. On start, voice greeting: "Hi, I am your eye assistant. What do you want me to do? Which camera, front or back?" → then "Eye assistant is ready. What next?"
2. Voice menu: (a) Take me to <place> (barber, bakery, medical shop); (b) Where am I? (home/office/street moderate/heavy traffic/forest/closed room); (c) Find object (goggles, purse, shoes); (d) Narrate live scene.
3. Narration order: FIRST describe the place/situation, THEN ongoing narration. Full descriptive sentences with direction, not single words. No fake precise distances/depth. Interactive.
4. Goal: a real product, not a POC. Research blind users' real daily problems.

## Root causes of field-test failures (code trace 2026-10-09)
- "Step ahead" false alarms: `terrain.ts findStep` takes the single biggest jump in a per-frame-normalised RELATIVE depth column, threshold 0.055, no multi-frame confirmation; urgency up to 0.95 → interrupts everything. Desk edges, rugs, shadows trigger it.
- "Blocked ahead" everywhere indoors: `freespace.ts` blocks when anything is < 3 m in the centre lane; unknown-size objects get a fake distance (area×40); depth openness also vetoes. Urgency 0.75 = HAZARD priority → interrupts narration.
- "Person/car coming towards you": `tracking.ts` treats shrinking distance as approach. When the USER walks forward, static people and parked cars "approach" at walking speed (> 0.45 m/s threshold). No ego-motion compensation.
- Place intro cut off / missing: local layer speaks from first frames at HAZARD priority while place check (structured output, slow) is still running.
- Choppy style: local layer speaks fixed templates ("Blocked ahead.") straight to the user instead of feeding them as context to the narrator.

## Research summary (10 sources, 2026-10-09; full report summarised here)
- Scale: WHO 2.2 bn with vision impairment; India ~4.8 M blind, ~74 M visually impaired (PLOS One national survey; PIB). Users skew older and less literate → voice-first, zero text.
- Diary study (arXiv 2602.13469): object ID 21.5%, reading 13.8%, finding objects, navigation; 66% of use at home. 22% of follow-ups had false info, text reading 34.6% errors; models answer confidently instead of declining.
- Live-video study (arXiv 2508.03651): users want proactive alerts tied to their goal; hated: no spatial memory, wrong directions, sycophancy, cheerleading, being asked to "look" or "ask someone"; describe new scene first (pro remote guides do this); store a user ability profile.
- Navigation LLM study (arXiv 2502.14883): concise but specific; structure = one-line overview → key obstacles → steps; clock directions valued but models confuse image vs body frame → compute directions ourselves; no generic "be careful" lines.
- RNIB guiding: announce kerbs/steps before reaching them with up/down; say where hazards are.
- India: mixed-use footpaths (vendors, two-wheelers, encroachment); Supreme Court 2026 right-to-walk ruling.
- Design rules: brief by default; overview→hazards→action; body-relative directions computed in code; say "not sure" instead of guessing; don't flip on pushback; alert only on goal-relevant hazards; neutral tone; never "safe to cross"; spoken onboarding + stored profile.

## Working rules from the user
- Present one section at a time. Do not dump everything at once.
- Store decisions in this file / memory and reread before new work.
- Explain things in simple language.
