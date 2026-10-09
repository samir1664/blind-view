# Section 1 — Cloud Foundation: Design

Status: approved in chat 2026-10-08. Roadmap: `2026-10-08-hackathon-roadmap.md`.

## Goal
Today's working app runs at a public HTTPS link on Google Cloud, calls Gemini through **Vertex AI** (covered by the $300 credit, no daily cap), and only our own app can spend our AI budget.

Done when: a judge opens `https://<project>.web.app` on Android Chrome or iPhone Safari, taps Start, and hears hazard call-outs plus Gemini narration — with no API key anywhere in the browser or the repo.

## Out of scope (later sections)
MediaPipe swap, Gemini hazard boxes, Live companion, SOS, navigation.

## Components

### 1. Model provider (server) — `apps/server/src/gemini.ts`, `env.ts`
- New env `GEMINI_PROVIDER` = `vertex` (default when `GOOGLE_CLOUD_PROJECT` is set) | `aistudio` (local fallback with `GEMINI_API_KEY`).
- Vertex settings: `GOOGLE_CLOUD_PROJECT`, `VERTEX_LOCATION` (default `global`), `GEMINI_MODEL` (comma list, tried in order — kept from today).
- Endpoint:
  - global: `https://aiplatform.googleapis.com/v1/projects/{p}/locations/global/publishers/google/models/{m}:generateContent`
  - regional: `https://{loc}-aiplatform.googleapis.com/v1/projects/{p}/locations/{loc}/publishers/google/models/{m}:generateContent`
- Auth: `google-auth-library` Application Default Credentials. On Cloud Run = the service account; on the Mac = `gcloud auth application-default login`. Header `Authorization: Bearer <token>`.
- Request body is unchanged (Vertex accepts the same `systemInstruction / contents / generationConfig / safetySettings` JSON).
- Error mapping unchanged; add 401/403 from Vertex -> "Vision service is not authorised." (not retryable).
- `/api/health` -> `visionConfigured` is true when the active provider is configured.

### 2. Request guard (server) — new `apps/server/src/guard.ts`
- Verifies **App Check** token (`X-Firebase-AppCheck` header) and **Firebase ID token** (`Authorization: Bearer`) with `firebase-admin`.
- `REQUIRE_APP_CHECK=true` on Cloud Run, `false` locally (so `npm run dev` keeps working without Firebase).
- Rate-limit key becomes the Firebase `uid` (falls back to IP when guard is off).
- Missing/invalid token -> 401 `{ error, code: 'UNAUTHENTICATED' }`. Applies to `/api/describe` and `/api/place`, not `/api/health`.

### 3. Firebase on the web — new `apps/web/src/lib/firebase.ts`
- Firebase web config from `VITE_FIREBASE_*` env (public by design, safe to ship).
- `initializeAppCheck` with `ReCaptchaEnterpriseProvider(VITE_RECAPTCHA_SITE_KEY)`, auto-refresh on. Local dev uses the App Check **debug token**.
- `signInAnonymously` once; no UI.
- `authHeaders(): Promise<Record<string,string>>` used by `lib/narration/api.ts` for every `/api` call.
- If `VITE_FIREBASE_API_KEY` is absent, Firebase is skipped and no headers are sent (local dev without a project still works).

### 4. Deploy
- `Dockerfile` + `.dockerignore` at repo root; Cloud Run builds from source (`gcloud run deploy --source .`) — no local Docker needed.
- Cloud Run service `blind-view-api`, region `asia-south1`, min 0 / **max 3** instances, 512 MiB, service account `blind-view-api@<project>.iam.gserviceaccount.com` with `roles/aiplatform.user`.
- `firebase.json`: Hosting serves `apps/web/dist`; rewrite `/api/**` -> Cloud Run `blind-view-api` (`asia-south1`); SPA fallback to `/index.html`.
- `ALLOWED_ORIGINS` on Cloud Run = `https://<project>.web.app,https://<project>.firebaseapp.com`.
- Root scripts: `deploy:api`, `deploy:web`, `deploy:api:preview` (tagged no-traffic revision).

### 5. Ops
- Budget alerts $50 / $150 / $250 on the billing account.
- Max 3 Cloud Run instances caps worst-case spend; existing per-client rate limit stays.

## Error handling
- Vertex auth failure -> 503 + clear message, logged once.
- App Check fails on a real device (e.g. reCAPTCHA blocked) -> 401; client shows "Security check failed. Reload the app." and on-device hazard alerts keep working.

## Testing
- Server unit tests with Node's built-in test runner via `tsx --test` (no new framework): endpoint builder, provider selection, guard accept/reject.
- Manual smoke: local Vertex call with ADC; deployed URL on Android + iPhone.

## Risks
- Vertex model IDs may differ from AI Studio IDs -> verified with a smoke call during Task 3 before deploy.
- Firebase Hosting -> Cloud Run rewrite region support for `asia-south1` -> verify at Task 7; fallback `asia-southeast1`.
