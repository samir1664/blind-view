import { useEffect, useRef, useState } from 'react';

import { FeedbackButtons } from './components/FeedbackButtons';
import { InstallPrompt, isInstalled } from './components/InstallPrompt'; 
import { PlaybackControls } from './components/PlaybackControls';
import { SettingsPanel } from './components/SettingsPanel';
import { Transcript } from './components/Transcript';
import { useEngine } from './hooks/useEngine';
import { audioEngine, Priority } from './lib/audio/AudioEngine';
import { isVoiceInputSupported } from './lib/speech/recognition'; 
import { useSession } from './store/session';
import { useSettings } from './store/settings';
import type { EngineStatus } from './types';

const STATUS_TEXT: Record<EngineStatus, string> = {
  idle: 'Stopped',
  'requesting-camera': 'Starting camera…',
  'loading-model': 'Loading detection model…',
  running: 'Running',
  error: 'Something went wrong',
};

export default function App() {
  const showPreview = useSettings((state) => state.showPreview);

  const status = useSession((state) => state.status);
  const error = useSession((state) => state.error);
  const busy = useSession((state) => state.busy);
  const listening = useSession((state) => state.listening);
  const visionConfigured = useSession((state) => state.visionConfigured);
  const place = useSession((state) => state.place);

  const { videoRef, toggle, requestMode, askByVoice, startAssistant, assistantRef } = useEngine();
  const runTool = (name: string, args: Record<string, unknown> = {}) => {
    const c = assistantRef.current;
    if (c) void c.runToolAndSpeak(name, args);
    else void startAssistant().then(() => void assistantRef.current?.runToolAndSpeak(name, args));
  };
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Voice-first startup: no instruction screen to read. Browsers block
  // speech until a user gesture, so the FIRST tap / keypress unlocks audio
  // and speaks the greeting (+ the short safety line on first launch only).
  // That same tap also starts the app via the tap-anywhere handler below.
  const greetedRef = useRef(false);
  useEffect(() => {
    const greet = async () => {
      if (greetedRef.current) return;
      greetedRef.current = true;
      await audioEngine.unlock();
      try {
        if (!localStorage.getItem('blindview:disclaimerSpoken:v1')) {
          localStorage.setItem('blindview:disclaimerSpoken:v1', '1');
          audioEngine.speak({
            text: 'Blind View helps you, it does not replace a white cane or a guide dog.',
            priority: Priority.INFO,
            source: 'system',
          });
        }
      } catch { /* private mode: skip the spoken safety line */ }
      audioEngine.speak({
        text: 'Hello, this is Blind View. Tap anywhere to start. Tap again to stop.',
        priority: Priority.INFO,
        source: 'system',
      });
      if (!isInstalled()) {
        audioEngine.speak({
          text: "Once it's on your Home Screen, you can say Hey Siri or Hey Google, open Blind View.",
          priority: Priority.INFO,
          source: 'system',
        });
      }
    };
    const onFirstGesture = () => { void greet(); };
    window.addEventListener('pointerdown', onFirstGesture, { once: true });
    window.addEventListener('keydown', onFirstGesture, { once: true });
    return () => {
      window.removeEventListener('pointerdown', onFirstGesture);
      window.removeEventListener('keydown', onFirstGesture);
    };
  }, []);

  const isRunning = status === 'running';
  const isStarting = status === 'requesting-camera' || status === 'loading-model';

  // The whole screen is one giant Start/Stop toggle. Taps on real controls
  // (buttons, inputs, the install card, the transcript) keep their own
  // behaviour and never toggle.
  const onTapAnywhere = (e: React.MouseEvent) => {
    if (isStarting) return;
    const el = e.target as HTMLElement;
    if (el.closest('button, a, input, select, textarea, [data-no-toggle]')) return;
    toggle();
  };

  return (
    <div
      className="app"
      onClick={onTapAnywhere}
      aria-label={isRunning ? 'Tap anywhere to stop Blind View' : 'Tap anywhere to start Blind View'}
    >
      {/* Kept mounted even when hidden: removing it from the DOM tears down
          the camera stream, and `display: none` pauses playback on Safari. */}
      <video
        ref={videoRef}
        className={showPreview ? 'preview' : 'preview preview--hidden'}
        playsInline
        muted
        aria-hidden="true"
      />

      <header className="topbar">
        <h1 className="topbar__title">Blind View</h1>
        <button
          type="button"
          className="btn btn--ghost"
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen((open) => !open)}
        >
          {settingsOpen ? 'Close settings' : 'Settings'}
        </button>
      </header>

      {/* Announced by screen readers whenever it changes. */}
      <p className="status" role="status" aria-live="polite">
        {error ?? STATUS_TEXT[status]}
        {listening ? ' — listening…' : busy ? ' — describing…' : ''}
      </p>

      {place ? (
        <p className="place" aria-label={`Detected place: ${place.path}`}>
          <span className="place__path">{place.path}</span>
          {place.watchFor.length > 0 ? (
            <span className="place__watch">Watch for: {place.watchFor.join(', ')}</span>
          ) : null}
        </p>
      ) : null}

      {visionConfigured === false ? (
        <p className="banner banner--warning" role="alert">
          Scene description is off: the server has no vision configured.
          Hazard alerts still work. Set <code>GOOGLE_CLOUD_PROJECT</code> (Vertex AI) or <code>GEMINI_API_KEY</code> in <code>.env</code> and restart.
        </p>
      ) : null}

      {settingsOpen ? (
        <section className="panel" aria-label="Settings" data-no-toggle>
          <SettingsPanel />
        </section>
      ) : (
        <>
          <InstallPrompt />
          <button
            type="button"
            className={`main-button ${isRunning ? 'main-button--on' : ''}`}
            aria-pressed={isRunning}
            disabled={isStarting}
            onClick={toggle}
          >
            <span className="main-button__title">
              {isStarting ? 'Starting…' : isRunning ? 'Stop' : 'Start'}
            </span>
            <span className="main-button__sub">
              {isRunning ? 'Tap anywhere to stop' : 'Tap anywhere to start'}
            </span>
          </button>

          <div className="playback-container">
            <PlaybackControls />
          </div>

          <nav className="actions" aria-label="Voice menu">
            <button type="button" className="btn btn--action" onClick={() => runTool('where_am_i')}>Where am I</button>
            <button type="button" className="btn btn--action" onClick={() => runTool('start_narration')}>Narrate</button>
            <button type="button" className="btn btn--action" onClick={() => runTool('find_object', { name: 'goggles' })}>Find goggles</button>
            <button type="button" className="btn btn--action" onClick={() => runTool('take_me_to', { place: 'bakery' })}>Take me to</button>
            <button type="button" className="btn btn--action" onClick={() => runTool('help')}>Help</button>
            <button type="button" className="btn btn--action" onClick={() => void startAssistant()}>Eye Assistant</button>
          </nav>

          <nav className="actions" aria-label="Ask about the view">
            <button
              type="button"
              className="btn btn--action"
              onClick={() => requestMode('scene')}
            >
              Describe now
            </button>
            <button
              type="button"
              className="btn btn--action"
              onClick={() => requestMode('text')}
            >
              Read text
            </button>
            <button
              type="button"
              className="btn btn--action"
              onClick={() => requestMode('currency')}
            >
              Identify money
            </button>
            <button
              type="button"
              className="btn btn--action"
              onClick={() => void askByVoice()}
              disabled={!isVoiceInputSupported() || listening}
            >
              {listening ? 'Listening…' : 'Ask a question'}
            </button>
          </nav>

          <section className="panel panel--transcript" aria-label="What was spoken" data-no-toggle>
            <h2 className="panel__heading">Spoken history</h2>
            <Transcript />
            <FeedbackButtons />
          </section>
        </>
      )}

      <footer className="footer">
        An assistive aid. Not a replacement for a cane, guide dog, or your own
        judgement.
      </footer>
    </div>
  );
}
