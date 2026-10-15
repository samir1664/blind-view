import { useCallback, useEffect, useRef } from 'react';
import type { DetectorModel } from '../lib/vision/detector';

import { audioEngine, Priority } from '../lib/audio/AudioEngine';
import type { PriorityLevel } from '../lib/audio/AudioEngine';
import type { EarconType } from '../lib/audio/earcons';
import { playEarcon } from '../lib/audio/earcons';
import { attachStream, CameraError, openCamera, stopStream } from '../lib/camera';
import { checkHealth, classifyPlace, describeFrame, NarrationError } from '../lib/narration/api';
import { NarrationDirector } from '../lib/narration/director';
import { listenOnce, parseCommand, VoiceInputError } from '../lib/speech/recognition';
import { captureFrame } from '../lib/vision/capture';
import { DepthEstimator } from '../lib/vision/depth';
import { accelMagnitude, MotionTracker, StillnessGate } from '../lib/vision/motion';
import type { StillnessResult } from '../lib/vision/motion';
import { analyzePath } from '../lib/vision/freespace';
import { explainUnusable, FrameScorer } from '../lib/vision/keyframe';
import { toSpatial } from '../lib/vision/spatial';
import { analyzeTerrain } from '../lib/vision/terrain';
import type { TerrainReport } from '../lib/vision/terrain';
import { ObjectTracker } from '../lib/vision/tracking';
import { AssistantController } from '../lib/assistant/controller';
import type { Sensitivity } from '../lib/vision/tracking';
import { useSession } from '../store/session';
import { useSettings } from '../store/settings';
import type { NarrationMode, PlaceContext, TranscriptSource } from '../types';

/**
 * The orchestrator: camera → on-device detection → hazard speech, plus a
 * slower cloud narration loop running alongside it.
 *
 * Deliberately built on refs and a single rAF loop rather than React state.
 * Re-rendering at 8 fps would fight the main thread that inference needs, and
 * nothing in the hot path has any business touching the DOM.
 */

/** How many recent narration lines to send back as anti-repetition context. */
const RECENT_CONTEXT = 3;

/** Don't nag about a blurry or dark view more than this often. */
const UNUSABLE_HINT_COOLDOWN_MS = 12_000;

/**
 * Backoff after a failed narration call.
 *
 * Without this, a quota error or an outage turns the narration loop into a
 * request flood: every interval fires another doomed call, which burns the
 * API quota and can run up a real bill. Each consecutive failure doubles the
 * wait, and a success resets it.
 */
const BACKOFF_BASE_MS = 3000;
const BACKOFF_MAX_MS = 120_000;

/** After this many consecutive failures, tell the user once and go quiet. */
const FAILURES_BEFORE_NOTICE = 3;

/**
 * Re-check what kind of place this is on this cadence.
 *
 * Places change rarely — you are in a kitchen for minutes, not milliseconds —
 * so this runs far slower than narration and its answer is reused across many
 * narration turns. That is what makes place-awareness cheap.
 */
const PLACE_INTERVAL_MS = 20_000;

/** A large change in the view may mean they walked somewhere new. */
const PLACE_CHANGE_THRESHOLD = 0.16;
const PLACE_MIN_GAP_MS = 8000;

/**
 * Depth cadence. Inference costs a few hundred milliseconds even in a worker,
 * and kerbs do not move, so roughly once a second is plenty. Running it faster
 * would just queue work the user never hears.
 */
const DEPTH_INTERVAL_MS = 900;

/** Terrain older than this is discarded rather than acted on. */
const TERRAIN_STALE_MS = 2500;

/**
 * Motion sampling for the stillness gate. A 64×48 thumbnail every 500 ms
 * is cheap, and it is a separate scorer so the narration keyframe scorer
 * keeps its own rhythm. Change >= this = the camera is moving.
 */
const MOTION_SCORE_MS = 500;
const FRAME_MOTION_THRESHOLD = 0.04;

/**
 * TensorFlow.js is ~1.4 MB. Loading it eagerly would delay first paint for a
 * user who only wants to read the disclaimer or change a setting, so it is
 * pulled in on demand when a session actually starts.
 */
type DetectorModule = typeof import('../lib/vision/detector');

export function useEngine() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const running = useRef(false);
  const stream = useRef<MediaStream | null>(null);
  const detector = useRef<DetectorModule | null>(null);
  const model = useRef<DetectorModel | null>(null);
  const tracker = useRef<ObjectTracker | null>(null);
  const director = useRef<NarrationDirector | null>(null);
  const scorer = useRef<FrameScorer | null>(null);
  const depth = useRef<DepthEstimator | null>(null);
  const terrain = useRef<TerrainReport | null>(null);
  const terrainAt = useRef(0);
  const lastDepthAt = useRef(0);
  const depthNoticeGiven = useRef(false);
  const rafId = useRef<number | null>(null);

  const detecting = useRef(false);
  const lastDetectAt = useRef(0);
  const lastNarrationAt = useRef(0);
  const lastUnusableHintAt = useRef(0);
  const narrationAbort = useRef<AbortController | null>(null);
  const narrationPending = useRef(false);
  const failureStreak = useRef(0);
  const narrationBlockedUntil = useRef(0);
  const place = useRef<PlaceContext | null>(null);
  const placePending = useRef(false);
  const placeAbort = useRef<AbortController | null>(null);
  const lastPlaceAt = useRef(0);
  const placeBlockedUntil = useRef(0);
  const lastFrameChange = useRef(0);
  const lastLabels = useRef<string[]>([]);
  const voiceCancel = useRef<(() => void) | null>(null);
  // S2-6: assistant controller (Live/Classic voice + /api/scene). Old describe/place loop stays as fallback.
  const assistant = useRef<AssistantController | null>(null);
  const localEvents = useRef<string[]>([]);
  const walking = useRef(false);
  // Motion-aware narration: step sensor + camera-frame change feed one gate.
  const motionTracker = useRef<MotionTracker | null>(null);
  const motionGate = useRef<StillnessGate | null>(null);
  const motionScorer = useRef<FrameScorer | null>(null);
  const motionMoving = useRef(false);
  const lastMotionScoreAt = useRef(0);
  const motionGateState = useRef<StillnessResult>('moving');
  const motionCleanup = useRef<(() => void) | null>(null);

  // ── Speaking helper ─────────────────────────────────────────
  useEffect(() => {
    audioEngine.onSpeak = (item) => {
      useSession.getState().addLine(item.source, item.text);
    };
    /**
     * A browser whose speech engine accepts utterances and never speaks would
     * otherwise leave the user in total silence with no indication anything is
     * wrong — the worst possible failure for this app. Say so on screen and in
     * the transcript, and keep the earcons running as a degraded mode.
     */
    audioEngine.onSpeechUnavailable = (reason) => {
      const session = useSession.getState();
      session.setError(reason);
      session.addLine('system', reason);
      playEarcon('error');
    };
    return () => {
      audioEngine.onSpeak = null;
      audioEngine.onSpeechUnavailable = null;
    };
  }, []);

  // Keep the engine in sync with settings the user changes mid-run.
  // Applied once on mount too: subscribe alone would leave the engine on
  // defaults (English voice) until the user touches a setting — so a
  // judge whose system is Hindi would hear nothing / wrong language.
  useEffect(() => {
    const apply = (settings: {
      speechRate: number;
      speechVolume: number;
      earconsEnabled: boolean;
      language: string;
      voiceURI: string | null;
      sensitivity: Sensitivity;
      hazardCooldownMs: number;
      calloutGapMs: number;
    }) => {
      audioEngine.setRate(settings.speechRate);
      audioEngine.setVolume(settings.speechVolume);
      audioEngine.setEarconsEnabled(settings.earconsEnabled);
      // Language first: setVoiceByUri falls back by language when the
      // saved voice does not exist on this device.
      audioEngine.setLanguage(settings.language);
      audioEngine.setVoiceByUri(settings.voiceURI);
      tracker.current?.setOptions({
        sensitivity: settings.sensitivity,
        cooldownMs: settings.hazardCooldownMs,
      });
      director.current?.setOptions({ minGapMs: settings.calloutGapMs });
    };
    apply(useSettings.getState());
    return useSettings.subscribe(apply);
  }, []);

  // Probe the server once so we can tell the user up front if narration is off.
  useEffect(() => {
    void checkHealth().then((health) => {
      useSession.getState().setVisionConfigured(health.visionConfigured);
    });
  }, []);

  // Silence everything if the app is backgrounded.
  useEffect(() => {
    const onHidden = () => {
      if (document.hidden) audioEngine.stopAll();
    };
    document.addEventListener('visibilitychange', onHidden);
    return () => document.removeEventListener('visibilitychange', onHidden);
  }, []);

  const say = useCallback(
    (
      text: string,
      priority: PriorityLevel,
      source: TranscriptSource,
      options?: { earcon?: EarconType; pan?: number },
    ) => {
      audioEngine.speak({
        text,
        priority,
        source,
        earcon: options?.earcon,
        pan: options?.pan,
      });
    },
    [],
  );

  // ── Place classification ────────────────────────────────────
  /**
   * Work out what kind of place this is, broad to specific, and announce it
   * when it changes. Narration then uses that place's own vocabulary and
   * hazard list — "escalator ahead going down" instead of "steps ahead".
   */
  const runPlaceCheck = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !running.current || placePending.current) return;
    if (useSession.getState().visionConfigured === false) return;

    const frame = captureFrame(video, 512, 0.7);
    if (!frame) return;

    const controller = new AbortController();
    placeAbort.current = controller;
    placePending.current = true;
    lastPlaceAt.current = Date.now();

    try {
      const next = await classifyPlace({
        frame,
        previous: place.current,
        detections: lastLabels.current,
        signal: controller.signal,
      });

      if (!running.current) return;

      const previous = place.current;
      place.current = next;
      useSession.getState().setPlace(next);
      placeBlockedUntil.current = 0;

      // Only speak when they have actually moved somewhere different, and
      // only when the classifier is reasonably sure.
      const changed =
        !previous ||
        previous.category !== next.category ||
        previous.place !== next.place;

      if (changed && next.confidence >= 0.5 && next.announcement) {
        audioEngine.speak({
          text: next.announcement,
          priority: Priority.ALERT,
          source: 'place',
          earcon: 'info',
          dedupeKey: `place:${next.path}`,
          cooldownMs: 30_000,
          ttlMs: 8000,
        });
        director.current?.noteSpoken(next.announcement);
      }
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      // Place detection is an enhancement, not a safety function. If it fails,
      // narration carries on without it — just back off so we stop retrying.
      const waitSec =
        error instanceof NarrationError ? error.retryAfterSec : 0;
      placeBlockedUntil.current = Date.now() + Math.max(30_000, waitSec * 1000);
    } finally {
      placePending.current = false;
      placeAbort.current = null;
    }
  }, []);

  // ── Cloud narration ─────────────────────────────────────────
  const runNarration = useCallback(
    async (mode: NarrationMode, query?: string, userInitiated = false) => {
      const video = videoRef.current;
      const session = useSession.getState();
      const settings = useSettings.getState();

      if (!video || !running.current) return;
      if (narrationPending.current) {
        // A request is already in flight. Cancel it only when the user has
        // explicitly asked for something new.
        if (!userInitiated) return;
        narrationAbort.current?.abort();
      }

      if (session.visionConfigured === false) {
        if (userInitiated) {
          say(
            'Scene description is not set up. Add your Gemini API key to the server.',
            Priority.ALERT,
            'system',
            { earcon: 'error' },
          );
        }
        return;
      }

      const score = scorer.current?.score(video) ?? null;
      if (score) lastFrameChange.current = score.change;
      if (score && !score.usable) {
        const reason = explainUnusable(score);
        const now = Date.now();
        if (
          reason &&
          (userInitiated || now - lastUnusableHintAt.current > UNUSABLE_HINT_COOLDOWN_MS)
        ) {
          lastUnusableHintAt.current = now;
          say(reason, Priority.ALERT, 'system', { earcon: 'alert' });
        }
        // Retry sooner than a full interval — the user may just be mid-stride.
        lastNarrationAt.current = Date.now() - settings.narrationIntervalMs / 2;
        return;
      }

      const frame = captureFrame(video);
      if (!frame) return;

      const controller = new AbortController();
      narrationAbort.current = controller;
      narrationPending.current = true;
      lastNarrationAt.current = Date.now();
      useSession.getState().setBusy(true);

      try {
        const result = await describeFrame({
          frame,
          mode,
          verbosity: settings.verbosity,
          query,
          // Feed back everything already spoken — including the on-device
          // call-outs — so the model never repeats what the user just heard.
          recent:
            mode === 'scene' || mode === 'guide'
              ? (director.current?.recentLines() ?? []).slice(0, RECENT_CONTEXT)
              : [],
          detections: lastLabels.current,
          place: place.current,
          signal: controller.signal,
        });

        if (!running.current && !userInitiated) return;

        director.current?.noteSpoken(result.text);

        // Recovered: clear the failure streak and any earlier transient error.
        failureStreak.current = 0;
        narrationBlockedUntil.current = 0;
        useSession.getState().setError(null);

        audioEngine.speak({
          text: result.text,
          // A direct question deserves to jump ahead of ambient narration,
          // but still never ahead of a hazard.
          priority: userInitiated ? Priority.ALERT : Priority.NARRATION,
          source: mode,
          earcon: userInitiated ? 'info' : undefined,
          ttlMs: userInitiated ? 20_000 : 9000,
        });
      } catch (error) {
        if ((error as Error).name === 'AbortError') return;

        const message =
          error instanceof NarrationError
            ? error.message
            : 'Scene description failed.';

        // Exponential backoff, honouring an explicit Retry-After when the
        // server sends one. This is what stops a quota error from becoming
        // hundreds of doomed requests a minute.
        failureStreak.current += 1;
        const serverWaitMs =
          error instanceof NarrationError ? error.retryAfterSec * 1000 : 0;
        const backoffMs = Math.min(
          BACKOFF_MAX_MS,
          BACKOFF_BASE_MS * 2 ** (failureStreak.current - 1),
        );
        narrationBlockedUntil.current =
          Date.now() + Math.max(backoffMs, serverWaitMs);

        // Background failures stay quiet; interrupting a walking user with
        // network errors every few seconds is worse than saying nothing. But
        // they do deserve to know once that narration has stopped.
        if (userInitiated || failureStreak.current === FAILURES_BEFORE_NOTICE) {
          say(message, Priority.ALERT, 'system', { earcon: 'error' });
        }
        useSession.getState().setError(message);
      } finally {
        narrationPending.current = false;
        narrationAbort.current = null;
        useSession.getState().setBusy(false);
      }
    },
    [say],
  );

  // ── Main loop ───────────────────────────────────────────────
  const tick = useCallback(() => {
    if (!running.current) return;
    rafId.current = requestAnimationFrame(tick);

    const video = videoRef.current;
    if (!video || video.readyState < 2) return;

    const now = Date.now();
    const settings = useSettings.getState();

    // Tier 1 — on-device hazards.
    if (
      settings.hazardsEnabled &&
      model.current &&
      detector.current &&
      !detecting.current &&
      now - lastDetectAt.current >= settings.detectIntervalMs
    ) {
      detecting.current = true;
      lastDetectAt.current = now;

      void detector.current
        .detectFrame(model.current, video, {
          minScore: settings.minConfidence,
        })
        .then((detections) => {
          if (!running.current) return;

          lastLabels.current = [...new Set(detections.map((d) => d.label))].slice(
            0,
            8,
          );

          const mirrored = settings.cameraFacing === 'user';
          const spatial = detections.map((detection) =>
            toSpatial(detection, video.videoWidth, video.videoHeight, mirrored),
          );

          const at = Date.now();

          // Terrain is produced asynchronously on a slower loop; only use it
          // while it is still describing roughly the same view.
          const freshTerrain =
            at - terrainAt.current <= TERRAIN_STALE_MS ? terrain.current : null;

          // Motion across frames is what turns "a dog" into "a dog coming
          // towards you", and what makes time-to-contact — and therefore
          // "stop" — possible at all.
          const result = tracker.current?.update(spatial, video.videoWidth, at);

          const guidance = settings.pathGuidanceEnabled
            ? analyzePath(
                spatial,
                video.videoWidth,
                video.videoHeight,
                freshTerrain,
              )
            : null;

          // One voice: the director merges object events, ground breaks and
          // path steers into a single paced utterance instead of three
          // systems interrupting each other.
          const utterances =
            director.current?.submit(
              result?.events ?? [],
              guidance,
              settings.terrainEnabled ? freshTerrain : null,
              at,
            ) ?? [];

          for (const utterance of utterances) {
            audioEngine.speak(utterance);
          }
        })
        .catch(() => {
          /* a dropped frame is not worth surfacing */
        })
        .finally(() => {
          detecting.current = false;
        });
    }

    // Motion — feeds the stillness gate (moving = narrate, still = ask once).
    // Sampled at 2 Hz so the gate sees real movement, not per-frame noise.
    // Never prompts while a Find / question is in progress: the gate resets
    // instead, so the still clock restarts after the interaction.
    if (now - lastMotionScoreAt.current >= MOTION_SCORE_MS) {
      lastMotionScoreAt.current = now;
      // Only user-driven work resets the still clock (a question / Find).
      // A background place check must not resume narration while standing still.
      const busy =
        narrationPending.current ||
        assistant.current?.isFinding === true;
      if (busy) {
        motionGate.current?.reset(now);
        motionGateState.current = 'moving';
      } else if (motionGate.current && motionScorer.current) {
        const score = motionScorer.current.score(video);
        const frameMoving =
          score !== null && score.change >= FRAME_MOTION_THRESHOLD;
        motionMoving.current = frameMoving || walking.current;
        motionGateState.current = motionGate.current.update(motionMoving.current, now);
      }
    }

    // Tier 2 — cloud narration, paused while the user stands still.
    if (motionGateState.current === 'prompt') {
      // Asked once per still period (gate guarantees it). Narration stays
      // paused until movement resumes; the mic stays listening for commands.
      motionGateState.current = 'waiting';
      say('How can I help?', Priority.ALERT, 'system');
    } else if (motionGateState.current === 'resumed') {
      motionGateState.current = 'moving';
      say("You're moving again.", Priority.INFO, 'system');
      // Fresh place-first update on the next pass below.
      lastNarrationAt.current = 0;
    }
    if (
      settings.narrationEnabled &&
      motionGateState.current !== 'waiting' &&
      !narrationPending.current &&
      now >= narrationBlockedUntil.current &&
      now - lastNarrationAt.current >= settings.narrationIntervalMs
    ) {
      // Guide mode narrates terrain and route continuously; scene mode gives
      // periodic standalone descriptions.
      void runNarration(settings.walkMode ? 'guide' : 'scene');
    }

    // Terrain — sees the kerbs, steps and unnamed obstacles the object
    // detector has no class for. Runs in a worker so this never blocks.
    if (
      settings.terrainEnabled &&
      depth.current &&
      !depth.current.disabled &&
      now - lastDepthAt.current >= DEPTH_INTERVAL_MS
    ) {
      lastDepthAt.current = now;
      void depth.current
        .estimate(video)
        .then((map) => {
          if (!running.current || !map) return;
          terrain.current = analyzeTerrain(map);
          terrainAt.current = Date.now();
        })
        .catch(() => {
          /* a dropped depth frame is not worth surfacing */
        });
    }

    // Tell the user once if the device turned out to be too slow for it.
    if (
      depth.current?.disabled &&
      !depthNoticeGiven.current &&
      settings.terrainEnabled
    ) {
      depthNoticeGiven.current = true;
      terrain.current = null;
      const reason = depth.current.disabledReason;
      if (reason) say(reason, Priority.INFO, 'system');
    }

    // Place context — slowest loop of the three. Re-checks on a timer, or
    // sooner when the view changes enough that they may have moved somewhere
    // genuinely different.
    if (
      settings.placeAwareEnabled &&
      settings.narrationEnabled &&
      !placePending.current &&
      now >= placeBlockedUntil.current
    ) {
      const elapsed = now - lastPlaceAt.current;
      const movedSomewhereNew =
        lastFrameChange.current >= PLACE_CHANGE_THRESHOLD &&
        elapsed >= PLACE_MIN_GAP_MS;

      if (elapsed >= PLACE_INTERVAL_MS || movedSomewhereNew) {
        void runPlaceCheck();
      }
    }
  }, [runNarration, runPlaceCheck, say]);

  // ── Lifecycle ───────────────────────────────────────────────
  /**
   * Step sensor for walking detection. DeviceMotion alone is never required:
   * camera-frame change is the primary motion signal, and any failure here
   * (no sensor, no permission, private mode) is silently ignored.
   * Fire-and-forget: must run in the tap gesture on iOS to get permission.
   */
  const setupMotionSensor = useCallback(() => {
    try {
      if (typeof window === 'undefined' || !('DeviceMotionEvent' in window)) return;
      const tracker = new MotionTracker();
      motionTracker.current = tracker;
      const onMotion = (e: DeviceMotionEvent) => {
        try {
          const a = e.accelerationIncludingGravity;
          if (!a || a.x == null || a.y == null || a.z == null) return;
          walking.current = tracker.update(accelMagnitude(a.x, a.y, a.z)) === 'walking';
        } catch { /* a bad sensor sample never breaks the app */ }
      };
      const attach = () => {
        window.addEventListener('devicemotion', onMotion);
        motionCleanup.current = () => window.removeEventListener('devicemotion', onMotion);
      };
      const DM = window.DeviceMotionEvent as unknown as {
        requestPermission?: () => Promise<string>;
      };
      if (typeof DM.requestPermission === 'function') {
        void DM.requestPermission().then((r) => { if (r === 'granted') attach(); }).catch(() => undefined);
      } else {
        attach();
      }
    } catch { /* no motion sensor: camera-frame motion still works */ }
  }, []);

  const start = useCallback(async () => {
    if (running.current) return;
    // Runs in the tap gesture (needed for iOS motion permission).
    setupMotionSensor();

    const session = useSession.getState();
    const settings = useSettings.getState();

    session.setError(null);

    // Must happen inside the user's tap, or iOS will never let us speak.
    await audioEngine.unlock();
    audioEngine.setRate(settings.speechRate);
    audioEngine.setVolume(settings.speechVolume);
    audioEngine.setEarconsEnabled(settings.earconsEnabled);
    audioEngine.setLanguage(settings.language);
    audioEngine.setVoiceByUri(settings.voiceURI);
    audioEngine.resetDedupe();

    try {
      session.setStatus('requesting-camera');
      say('Starting camera.', Priority.INFO, 'system', { earcon: 'start' });

      const mediaStream = await openCamera(settings.cameraFacing);
      stream.current = mediaStream;

      const video = videoRef.current;
      if (!video) throw new CameraError('Video element is missing.', 'no-element');
      await attachStream(video, mediaStream);

      session.setStatus('loading-model');
      detector.current ??= await import('../lib/vision/detector');
      model.current = await detector.current.loadDetector();

      tracker.current = new ObjectTracker({
        sensitivity: settings.sensitivity,
        cooldownMs: settings.hazardCooldownMs,
      });
      director.current = new NarrationDirector({
        minGapMs: settings.calloutGapMs,
      });
      scorer.current = new FrameScorer();
      // Fresh motion state per session: still clock starts when they start moving.
      motionTracker.current?.reset();
      motionGate.current = new StillnessGate();
      motionScorer.current = new FrameScorer();
      motionMoving.current = false;
      motionGateState.current = 'moving';
      lastMotionScoreAt.current = 0;
      depth.current ??= new DepthEstimator();
      terrain.current = null;
      terrainAt.current = 0;
      lastDepthAt.current = 0;
      depthNoticeGiven.current = false;
      lastLabels.current = [];
      failureStreak.current = 0;
      narrationBlockedUntil.current = 0;
      place.current = null;
      placeBlockedUntil.current = 0;
      lastFrameChange.current = 0;
      // Identify the place almost immediately, so the very first description
      // already uses the right vocabulary.
      lastPlaceAt.current = Date.now() - PLACE_INTERVAL_MS + 1200;
      useSession.getState().setPlace(null);
      lastDetectAt.current = 0;
      // Let the first description fire almost immediately on start.
      lastNarrationAt.current = Date.now() - settings.narrationIntervalMs + 900;

      running.current = true;
      session.setStatus('running');
      say('Blind View is on.', Priority.INFO, 'system');

      rafId.current = requestAnimationFrame(tick);
    } catch (error) {
      const message =
        error instanceof CameraError
          ? error.message
          : 'Could not start. Please try again.';
      session.setStatus('error');
      session.setError(message);
      say(message, Priority.ALERT, 'system', { earcon: 'error' });
      stopStream(stream.current);
      stream.current = null;
    }
  }, [say, tick, setupMotionSensor]);

  const stop = useCallback(() => {
    running.current = false;

    if (rafId.current !== null) {
      cancelAnimationFrame(rafId.current);
      rafId.current = null;
    }

    narrationAbort.current?.abort();
    narrationAbort.current = null;
    narrationPending.current = false;

    placeAbort.current?.abort();
    placeAbort.current = null;
    placePending.current = false;
    place.current = null;

    voiceCancel.current?.();
    voiceCancel.current = null;

    // Stop cancels everything, including a Find loop in the assistant.
    assistant.current?.close();
    assistant.current = null;

    // Motion sensor off, stillness gate reset, walking state cleared.
    motionCleanup.current?.();
    motionCleanup.current = null;
    motionTracker.current?.reset();
    motionGate.current?.reset();
    motionGateState.current = 'moving';
    motionMoving.current = false;
    walking.current = false;

    stopStream(stream.current);
    stream.current = null;

    const video = videoRef.current;
    if (video) video.srcObject = null;

    tracker.current?.reset();
    director.current?.reset();
    scorer.current?.reset();
    terrain.current = null;
    terrainAt.current = 0;

    audioEngine.stopAll();
    audioEngine.resetDedupe();

    const session = useSession.getState();
    session.setStatus('idle');
    // Otherwise a timeout from the last in-flight request keeps showing in
    // place of "Stopped" forever.
    session.setError(null);
    session.setPlace(null);
    session.setBusy(false);
    session.setListening(false);

    audioEngine.speak({
      text: 'Blind View is off.',
      priority: Priority.INFO,
      source: 'system',
      earcon: 'stop',
    });
  }, []);

  const toggle = useCallback(() => {
    if (running.current) stop();
    else void start();
  }, [start, stop]);

  /** One-shot user request: describe, read text, find something, count money. */
  const requestMode = useCallback(
    (mode: NarrationMode, query?: string) => {
      if (!running.current) {
        say('Start Blind View first.', Priority.ALERT, 'system', {
          earcon: 'error',
        });
        return;
      }
      void runNarration(mode, query, true);
    },
    [runNarration, say],
  );

  /** Push-to-talk: listen for a phrase, then act on it. */
  const askByVoice = useCallback(async () => {
    if (!running.current) {
      say('Start Blind View first.', Priority.ALERT, 'system', { earcon: 'error' });
      return;
    }

    const session = useSession.getState();
    audioEngine.stopAll();
    session.setListening(true);

    const { promise, cancel } = listenOnce();
    voiceCancel.current = cancel;

    try {
      const transcript = await promise;
      session.addLine('system', `You: ${transcript}`);
      const command = parseCommand(transcript);
      void runNarration(command.mode, command.query, true);
    } catch (error) {
      const message =
        error instanceof VoiceInputError ? error.message : 'Voice input failed.';
      say(message, Priority.ALERT, 'system', { earcon: 'error' });
    } finally {
      voiceCancel.current = null;
      useSession.getState().setListening(false);
    }
  }, [runNarration, say]);

  useEffect(
    () => () => {
      running.current = false;
      if (rafId.current !== null) cancelAnimationFrame(rafId.current);
      narrationAbort.current?.abort();
      placeAbort.current?.abort();
      motionCleanup.current?.();
      motionCleanup.current = null;
      assistant.current?.close();
      assistant.current = null;
      depth.current?.dispose();
      stopStream(stream.current);
      audioEngine.dispose(); 
    },
    [],
  );

  // S2-6 + S2-10: start assistant (greeting -> camera -> orientation -> ready). Live first, ClassicVoice fallback on Live failure.
  const startAssistant = useCallback(async () => {
    const makeController = (voice: ConstructorParameters<typeof AssistantController>[0]['voice']) => new AssistantController({
      voice,
      getFrame: () => (videoRef.current ? captureFrame(videoRef.current) : null),
      getWalking: () => walking.current,
      getDetections: () => [...lastLabels.current],
      getFrameMoving: () => motionMoving.current,
      isMirrored: () => useSettings.getState().cameraFacing === 'user',
      getLocalEvents: () => [...localEvents.current],
      onCameraChange: (which) => {
        useSettings.getState().update({ cameraFacing: which === 'front' ? 'user' : 'environment' });
      },
      onStatus: () => {},
      onTranscript: (role, text) => useSession.getState().addLine(role === 'user' ? 'system' : 'guide', text),
    });
    try {
      const { LiveVoice } = await import('../lib/live/LiveVoice');
      const voice = new LiveVoice() as unknown as ConstructorParameters<typeof AssistantController>[0]['voice'];
      const controller = makeController(voice);
      assistant.current = controller;
      await controller.start();
    } catch {
      try {
        const { ClassicVoice } = await import('../lib/assistant/ClassicVoice');
        const voice = new ClassicVoice() as unknown as ConstructorParameters<typeof AssistantController>[0]['voice'];
        const controller = makeController(voice);
        assistant.current = controller;
        await controller.start();
      } catch { assistant.current = null; }
    }
  }, []);
  const stopAssistant = useCallback(() => { assistant.current?.close(); assistant.current = null; }, []);

  return { videoRef, start, stop, toggle, requestMode, askByVoice, startAssistant, stopAssistant, assistantRef: assistant };
}
