# Section 1 — Cloud Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy today's app to Firebase Hosting + Cloud Run, calling Gemini via Vertex AI, with App Check + anonymous Auth guarding the API.

**Architecture:** Hono server gains a Vertex provider (ADC auth) and a Firebase guard middleware; web app initialises Firebase (App Check + anon Auth) and attaches tokens to `/api` calls; Hosting rewrites `/api/**` to Cloud Run.

**Tech Stack:** Node 22, Hono, google-auth-library, firebase-admin, firebase (web), Vite/React, Cloud Run, Firebase Hosting, Vertex AI.

**Spec:** `docs/superpowers/specs/2026-10-08-section1-cloud-foundation-design.md`

## Global Constraints
- Repo root for all paths: `blind-view/` (the inner folder, `/Users/samir/Desktop/blind-view/blind-view`).
- No secrets in git or in the browser bundle. Only `VITE_FIREBASE_*` and `VITE_RECAPTCHA_SITE_KEY` may be `VITE_`-prefixed.
- Cloud Run region `asia-south1`; service `blind-view-api`; max instances 3.
- Local `npm run dev` must keep working with no Firebase config and an AI Studio key (`GEMINI_PROVIDER=aistudio`).
- Node >= 20; ESM; TypeScript strict.

## Review Focus
- Firebase not configured locally -> app must still start and narrate (guard off, no headers).
- App Check token expired mid-session -> SDK auto-refresh; a single 401 must not loop requests (existing backoff handles it).
- Vertex model ID wrong -> 404 -> falls through to next model in `GEMINI_MODEL` list (existing behaviour) with a clear log.
- Cloud Run cold start (~2-4 s) on first describe -> existing 15 s timeout covers it.
- iPhone Safari blocks third-party cookies -> reCAPTCHA Enterprise must still issue tokens (verify on device in Task 7).

---

### Task 1: Google Cloud + Firebase project (user-assisted) — DONE 2026-10-08

**Files:** none (console + CLI). Record project ID in `docs/superpowers/specs/2026-10-08-hackathon-roadmap.md`.

- [ ] Step 1: User starts the Free Trial at https://console.cloud.google.com/freetrial and creates project (e.g. `blind-view-<suffix>`).
- [ ] Step 2: User adds Firebase to the same project at https://console.firebase.google.com (choose the existing GCP project).
- [ ] Step 3: Install CLIs: `brew install --cask google-cloud-sdk` and `npm i -g firebase-tools`. User runs `gcloud auth login`, `gcloud auth application-default login`, `firebase login`.
- [ ] Step 4: `gcloud config set project <ID>`; enable APIs:
  `gcloud services enable aiplatform.googleapis.com run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com firebaseappcheck.googleapis.com recaptchaenterprise.googleapis.com identitytoolkit.googleapis.com secretmanager.googleapis.com`
- [ ] Step 5: User creates a budget ($300, alerts 17% / 50% / 83% ≈ $50/$150/$250) in Billing → Budgets & alerts.
- [ ] Step 6: Verify: `gcloud config list` shows the project; `firebase projects:list` lists it.

### Task 2: Server test harness — DONE (376ea06)

**Files:**
- Modify: `apps/server/package.json` (add `"test": "tsx --test src/**/*.test.ts"`)
- Create: `apps/server/src/smoke.test.ts`

- [ ] Step 1: Add the script and a trivial test `test('harness runs', () => assert.ok(true))` using `node:test` + `node:assert/strict`.
- [ ] Step 2: Run `npm test -w @blind-view/server` → PASS.
- [ ] Step 3: Commit `chore(server): add node test harness`.

### Task 3: Vertex AI provider — DONE (3dc2210). Smoke: /api/describe via Vertex 1.7-2.2 s.

**Files:**
- Modify: `apps/server/src/env.ts`, `apps/server/src/gemini.ts`, `apps/server/src/index.ts` (health), `.env.example`
- Create: `apps/server/src/provider.ts`, `apps/server/src/provider.test.ts`

**Interfaces:**
- Produces: `type Provider = 'vertex' | 'aistudio'`; `env.provider`, `env.gcpProject`, `env.vertexLocation`; `isVisionConfigured(): boolean`;
  `buildEndpoint(provider, model, { project, location }): string`;
  `authHeaders(provider): Promise<Record<string,string>>`.

- [ ] Step 1: Failing tests in `provider.test.ts`:
  - global location → `https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google/models/m:generateContent`
  - `asia-south1` → `https://asia-south1-aiplatform.googleapis.com/v1/projects/p/locations/asia-south1/publishers/google/models/m:generateContent`
  - aistudio → `https://generativelanguage.googleapis.com/v1beta/models/m:generateContent`
  - model id is URL-encoded.
- [ ] Step 2: Run → FAIL (module missing).
- [ ] Step 3: Implement `provider.ts`. `authHeaders('vertex')` uses a module-level `new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' })` and `await auth.getAccessToken()`; `authHeaders('aistudio')` returns `{ 'x-goog-api-key': env.geminiApiKey }`.
  `env.provider` = `GEMINI_PROVIDER` if valid, else `'vertex'` when `GOOGLE_CLOUD_PROJECT` set, else `'aistudio'`.
- [ ] Step 4: `npm i google-auth-library -w @blind-view/server`; run tests → PASS.
- [ ] Step 5: In `gemini.ts` `callModel`, replace the hard-coded URL/header with `buildEndpoint` + `authHeaders`; map Vertex 401/403 to `GeminiError('Vision service is not authorised.', 503, false)`. Replace `hasGeminiKey` uses with `isVisionConfigured()`.
- [ ] Step 6: Smoke locally: `.env` with `GOOGLE_CLOUD_PROJECT=<ID>`, `VERTEX_LOCATION=global`, `GEMINI_MODEL=<flash-lite id>`; `npm run dev:server`; `curl -s localhost:8787/api/health` → `visionConfigured: true`; open app on laptop, tap Describe now → spoken description. If 404, list valid IDs in Vertex Model Garden and fix `GEMINI_MODEL`.
- [ ] Step 7: `npm run typecheck`; commit `feat(server): call Gemini through Vertex AI`.

### Task 4: Request guard (App Check + ID token) — DONE (a9d92c9). Real firebase-admin rejects forged tokens with 401. Verifiers live in `apps/server/src/firebaseAuth.ts`.

**Files:**
- Create: `apps/server/src/guard.ts`, `apps/server/src/guard.test.ts`
- Modify: `apps/server/src/index.ts`, `apps/server/src/env.ts`

**Interfaces:**
- Produces: `createGuard(opts: { required: boolean; verifyAppCheck(t: string): Promise<unknown>; verifyIdToken(t: string): Promise<{ uid: string }> })` → Hono middleware that sets `c.set('clientKey', uid | ip)`.
- `env.requireAppCheck` from `REQUIRE_APP_CHECK === 'true'`.

- [ ] Step 1: Failing tests with fake verifiers: required + missing header → 401; required + bad token → 401; required + valid → next() with `clientKey === uid`; not required + no headers → next() with IP key.
- [ ] Step 2: Run → FAIL.
- [ ] Step 3: Implement with `createMiddleware` from `hono/factory`. Real verifiers: `getAppCheck().verifyToken`, `getAuth().verifyIdToken` from `firebase-admin` (init once with `initializeApp()` — ADC on Cloud Run).
- [ ] Step 4: `npm i firebase-admin -w @blind-view/server`; tests → PASS.
- [ ] Step 5: Mount on `/api/describe` and `/api/place`; use `c.get('clientKey')` for `checkRateLimit`; add `X-Firebase-AppCheck, Authorization` to CORS `allowHeaders`.
- [ ] Step 6: Typecheck; commit `feat(server): verify App Check and Firebase ID tokens`.

### Task 5: Firebase on the web client — DONE (053631f). Verified in browser with REQUIRE_APP_CHECK=true: tokens attached, text mode read "EXIT" in 1.9 s; no tokens → 401.

**Files:**
- Create: `apps/web/src/lib/firebase.ts`
- Modify: `apps/web/src/lib/narration/api.ts`, `.env.example`, `apps/web/vite.config.ts` (`envDir: '../..'` so root `.env` feeds `VITE_*`)

**Interfaces:**
- Produces: `firebaseEnabled: boolean`; `authHeaders(): Promise<Record<string, string>>` (empty object when disabled).

- [ ] Step 1: User registers a Web App in Firebase console; creates reCAPTCHA Enterprise key for domains `localhost`, `<ID>.web.app`, `<ID>.firebaseapp.com`; registers it under App Check → Apps. Copy config into root `.env` as `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`, `VITE_RECAPTCHA_SITE_KEY`. Enable Anonymous sign-in in Authentication.
- [ ] Step 2: `npm i firebase -w @blind-view/web`. Implement `firebase.ts`: in dev set `self.FIREBASE_APPCHECK_DEBUG_TOKEN = true` before `initializeAppCheck`; `signInAnonymously` lazily; `authHeaders` returns `{ 'X-Firebase-AppCheck': (await getToken(appCheck)).token, Authorization: 'Bearer ' + await user.getIdToken() }`.
- [ ] Step 3: In `api.ts`, merge `await authHeaders()` into both `fetch` calls; map 401 to `NarrationError('Security check failed. Reload the app.', 401, false)`.
- [ ] Step 4: Run locally with `REQUIRE_APP_CHECK=true`; register the printed debug token in App Check console; Describe now works. With Firebase vars removed it still works (guard off).
- [ ] Step 5: `npm run typecheck`; commit `feat(web): App Check + anonymous auth on API calls`.

### Task 6: Container + Cloud Run — DONE (836a257). Needed roles/run.builder on default compute SA.

**Files:** Create `Dockerfile`, `.dockerignore`; modify root `package.json` scripts.

- [ ] Step 1: `Dockerfile` (node:22-slim): copy root + both workspace `package.json` + lockfile, `npm ci -w @blind-view/server`, copy `apps/server`, `ENV NODE_ENV=production`, `CMD ["npm","run","start","-w","@blind-view/server"]`. `.dockerignore`: `node_modules`, `apps/web`, `.env*`, `.git`, `docs`.
- [ ] Step 2: Create service account and role:
  `gcloud iam service-accounts create blind-view-api` ; `gcloud projects add-iam-policy-binding <ID> --member=serviceAccount:blind-view-api@<ID>.iam.gserviceaccount.com --role=roles/aiplatform.user`
- [ ] Step 3: Script `deploy:api` = `gcloud run deploy blind-view-api --source . --region asia-south1 --service-account blind-view-api@<ID>.iam.gserviceaccount.com --max-instances 3 --memory 512Mi --allow-unauthenticated --set-env-vars GOOGLE_CLOUD_PROJECT=<ID>,VERTEX_LOCATION=global,GEMINI_MODEL=<ids>,REQUIRE_APP_CHECK=true,ALLOWED_ORIGINS=https://<ID>.web.app,https://<ID>.firebaseapp.com`. (`--allow-unauthenticated` is required for Hosting rewrites; the guard does the real check.) `deploy:api:preview` adds `--no-traffic --tag preview`.
- [ ] Step 4: Run it; `curl <run-url>/api/health` → `visionConfigured: true`; `curl -X POST <run-url>/api/describe` without tokens → 401.
- [ ] Step 5: Commit `build: containerise API for Cloud Run`.

### Task 7: Firebase Hosting + end-to-end — DONE except phone test. Live: https://blind-view-ai.web.app. Production reCAPTCHA path verified (text mode read "PLATFORM 3" in 2.0 s).

**Files:** Create `firebase.json`, `.firebaserc`; root script `deploy:web` = `npm run build && firebase deploy --only hosting`.

- [ ] Step 1: `firebase.json` hosting: `public: apps/web/dist`, rewrites `[{ "source": "/api/**", "run": { "serviceId": "blind-view-api", "region": "asia-south1" } }, { "source": "**", "destination": "/index.html" }]`; cache headers: `/models/**`, `/ort/**` long-cache immutable; `index.html` and `sw.js` no-cache.
- [ ] Step 2: `npm run deploy:web`; open `https://<ID>.web.app/api/health` → JSON from Cloud Run.
- [ ] Step 3: On Android Chrome and iPhone Safari: Start → camera + speech; Describe now → narration; Read text works.
- [ ] Step 4: Commit `build: Firebase Hosting with Cloud Run rewrite`; update roadmap Section 1 → Done; record the live URL.
