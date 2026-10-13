import { useState } from 'react';

import { Disclaimer } from './components/Disclaimer';
import { FeedbackButtons } from './components/FeedbackButtons'; 
import { PlaybackControls } from './components/PlaybackControls';
import { SettingsPanel } from './components/SettingsPanel';
import { Transcript } from './components/Transcript';
import { useEngine } from './hooks/useEngine';
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
  const disclaimerAcceptedAt = useSettings((state) => state.disclaimerAcceptedAt);
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

  // Hooks must run unconditionally, so this guard comes after them.
  if (!disclaimerAcceptedAt) return <Disclaimer />;

  const isRunning = status === 'running';
  const isStarting = status === 'requesting-camera' || status === 'loading-model';

  return (
    <div className="app">
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
        <section className="panel" aria-label="Settings">
          <SettingsPanel />
        </section>
      ) : (
        <>
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
              {isRunning
                ? 'Blind View is listening to the camera'
                : 'Tap anywhere in this area to begin'}
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

          <section className="panel panel--transcript" aria-label="What was spoken">
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
