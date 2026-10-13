import { useEffect, useState } from 'react';

import { audioEngine } from '../lib/audio/AudioEngine';
import type { AudioDiagnostics } from '../lib/audio/AudioEngine';
import { playEarcon, unlockAudio } from '../lib/audio/earcons';
import {
  hasVoiceForLanguage,
  resolveSpeechLanguage,
  SUPPORTED_LANGUAGES,
} from '../lib/audio/voice';

/** The device language, for the "System default" label. */
const systemLanguage =
  typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en';

import { useSettings } from '../store/settings';
import type { Sensitivity } from '../lib/vision/tracking';
import type { Verbosity } from '../types';

export function SettingsPanel() {
  const settings = useSettings();
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [report, setReport] = useState<AudioDiagnostics | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    const load = () => setVoices(audioEngine.getVoices());
    load();
    // Chrome populates the voice list asynchronously after first paint.
    window.speechSynthesis?.addEventListener('voiceschanged', load);
    return () =>
      window.speechSynthesis?.removeEventListener('voiceschanged', load);
  }, []);

  /**
   * Beeps only, no speech. WebAudio and speech synthesis fail independently,
   * so hearing this but not the voice narrows the problem to speech alone —
   * and hearing nothing at all points at the output device, not the app.
   */
  const beepOnly = async () => {
    await unlockAudio();
    playEarcon('hazard', -0.8);
    window.setTimeout(() => playEarcon('alert', 0), 600);
    window.setTimeout(() => playEarcon('info', 0.8), 1200);
  };

  const preview = async () => {
    setTesting(true);
    setReport(null);
    audioEngine.stopAll();

    const result = await audioEngine.diagnose();

    // If a fallback voice was the one that actually spoke, make it the user's
    // saved choice — otherwise the settings subscription resets it and the
    // silence comes straight back.
    if (result.workingVoiceUri && result.workingVoiceUri !== settings.voiceURI) {
      settings.update({ voiceURI: result.workingVoiceUri });
    }

    setReport(result);
    setTesting(false);
  };

  return (
    <div className="settings">
      <fieldset className="settings__group">
        <legend>What you hear</legend>

        <Toggle
          label="Hazard alerts"
          hint="Instant warnings from on-device detection."
          checked={settings.hazardsEnabled}
          onChange={(hazardsEnabled) => settings.update({ hazardsEnabled })}
        />
        <Toggle
          label="Walking guide"
          hint="Continuous narration of the path and surroundings as you move, instead of occasional standalone descriptions."
          checked={settings.walkMode}
          onChange={(walkMode) => settings.update({ walkMode })}
        />
        <Toggle
          label="Path steering"
          hint="Says things like “keep a bit left” when something blocks the way ahead."
          checked={settings.pathGuidanceEnabled}
          onChange={(pathGuidanceEnabled) =>
            settings.update({ pathGuidanceEnabled })
          }
        />
        <Toggle
          label="Place awareness"
          hint="Works out where you are — a kitchen, a mall escalator, a road crossing — and narrates using that place’s own vocabulary and hazards."
          checked={settings.placeAwareEnabled}
          onChange={(placeAwareEnabled) => settings.update({ placeAwareEnabled })}
        />
        <Toggle
          label="Steps and kerbs"
          hint="Detects steps, kerbs, drop-offs and obstacles the object detector cannot name. Runs on the device; switches itself off if too slow."
          checked={settings.terrainEnabled}
          onChange={(terrainEnabled) => settings.update({ terrainEnabled })}
        />
        <Toggle
          label="Scene narration"
          hint="Descriptions from the cloud. Uses the internet."
          checked={settings.narrationEnabled}
          onChange={(narrationEnabled) => settings.update({ narrationEnabled })}
        />
        <Toggle
          label="Sound cues"
          hint="Short tones before speech, panned to the side of the hazard."
          checked={settings.earconsEnabled}
          onChange={(earconsEnabled) => settings.update({ earconsEnabled })}
        />
      </fieldset>

      <fieldset className="settings__group">
        <legend>Sensitivity</legend>

        <label className="field">
          <span className="field__label">Alert sensitivity</span>
          <select
            value={settings.sensitivity}
            onChange={(event) =>
              settings.update({ sensitivity: event.target.value as Sensitivity })
            }
          >
            <option value="low">Low — only serious hazards</option>
            <option value="medium">Medium — recommended</option>
            <option value="high">High — announce more</option>
          </select>
        </label>

        <label className="field">
          <span className="field__label">Description detail</span>
          <select
            value={settings.verbosity}
            onChange={(event) =>
              settings.update({ verbosity: event.target.value as Verbosity })
            }
          >
            <option value="brief">Brief — one short sentence</option>
            <option value="normal">Normal — up to two sentences</option>
            <option value="detailed">Detailed — full description</option>
          </select>
        </label>

        <Slider
          label="Time between descriptions"
          value={settings.narrationIntervalMs}
          min={4000}
          max={20000}
          step={1000}
          format={(v) => `${Math.round(v / 1000)} seconds`}
          onChange={(narrationIntervalMs) => settings.update({ narrationIntervalMs })}
        />

        <Slider
          label="Pace of call-outs"
          value={settings.calloutGapMs}
          min={800}
          max={5000}
          step={100}
          format={(v) => `${(v / 1000).toFixed(1)} seconds apart`}
          onChange={(calloutGapMs) => settings.update({ calloutGapMs })}
        />

        <Slider
          label="Gap before repeating a hazard"
          value={settings.hazardCooldownMs}
          min={2000}
          max={15000}
          step={500}
          format={(v) => `${(v / 1000).toFixed(1)} seconds`}
          onChange={(hazardCooldownMs) => settings.update({ hazardCooldownMs })}
        />
      </fieldset>

      <fieldset className="settings__group">
        <legend>Voice</legend>

        <Slider
          label="Speech speed"
          value={settings.speechRate}
          min={0.6}
          max={2.2}
          step={0.05}
          format={(v) => `${v.toFixed(2)} times`}
          onChange={(speechRate) => settings.update({ speechRate })}
        />

        <Slider
          label="Volume"
          value={settings.speechVolume}
          min={0}
          max={1}
          step={0.05}
          format={(v) => `${Math.round(v * 100)} percent`}
          onChange={(speechVolume) => settings.update({ speechVolume })}
        />

        <label className="field">
          <span className="field__label">Language</span>
          <select
            value={settings.language}
            onChange={(event) =>
              settings.update({ language: event.target.value })
            }
          >
            {SUPPORTED_LANGUAGES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.value === 'system'
                  ? `System default (detected: ${systemLanguage})`
                  : option.label}
              </option>
            ))}
          </select>
          <span className="field__hint">
            Follows this device unless you pick one. If this device has no
            voice for the language, Blind View uses the cloud voice instead
            of staying silent.
          </span>
        </label>

        {!hasVoiceForLanguage(voices, settings.language) && voices.length > 0 ? (
          <p className="field__hint" role="status">
            No {resolveSpeechLanguage(settings.language)} voice on this
            device — will use cloud voice.
          </p>
        ) : null}

        <label className="field">
          <span className="field__label">Voice</span>
          <select
            value={settings.voiceURI ?? ''}
            onChange={(event) =>
              settings.update({ voiceURI: event.target.value || null })
            }
          >
            <option value="">System default</option>
            {voices.map((voice) => (
              <option key={voice.voiceURI} value={voice.voiceURI}>
                {voice.name} ({voice.lang})
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => void beepOnly()}
        >
          Play test beeps (no speech)
        </button>

        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => void preview()}
          disabled={testing}
        >
          {testing ? 'Testing voices…' : 'Test the voice'}
        </button>

        {report ? (
          <div className="diagnostics" role="status" aria-live="polite">
            <p className="diagnostics__summary">{report.summary}</p>
            <dl className="diagnostics__grid">
              <dt>Beep (WebAudio)</dt>
              <dd>{report.audioContextState}</dd>
              <dt>Speech started</dt>
              <dd>{report.speechStarted ? 'yes' : 'no'}</dd>
              <dt>Speech finished</dt>
              <dd>{report.speechEnded ? 'yes' : 'no'}</dd>
              <dt>Voice used</dt>
              <dd>{report.selectedVoice}</dd>
              <dt>Voices available</dt>
              <dd>{report.voiceCount}</dd>
              {report.embeddedBrowser ? (
                <>
                  <dt>Browser</dt>
                  <dd>embedded preview — audio often unsupported</dd>
                </>
              ) : null}
            </dl>

            {report.voicesTried.length > 0 ? (
              <details className="diagnostics__details">
                <summary>Voices tried ({report.voicesTried.length})</summary>
                <ul>
                  {report.voicesTried.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        ) : null}
      </fieldset>

      <fieldset className="settings__group">
        <legend>Camera</legend>

        <label className="field">
          <span className="field__label">Which camera</span>
          <select
            value={settings.cameraFacing}
            onChange={(event) =>
              settings.update({
                cameraFacing: event.target.value as 'environment' | 'user',
              })
            }
          >
            <option value="environment">Rear camera — facing away from you</option>
            <option value="user">Front camera</option>
          </select>
          <span className="field__hint">
            Restart Blind View for this to take effect.
          </span>
        </label>

        <Toggle
          label="Show camera preview"
          hint="Only useful if you have some sight or a helper is looking."
          checked={settings.showPreview}
          onChange={(showPreview) => settings.update({ showPreview })}
        />
      </fieldset>

      <button type="button" className="btn btn--danger" onClick={settings.reset}>
        Reset all settings
      </button>
    </div>
  );
}

interface ToggleProps {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}

function Toggle({ label, hint, checked, onChange }: ToggleProps) {
  return (
    <label className="field field--toggle">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="field__text">
        <span className="field__label">{label}</span>
        {hint ? <span className="field__hint">{hint}</span> : null}
      </span>
    </label>
  );
}

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}

function Slider({ label, value, min, max, step, format, onChange }: SliderProps) {
  return (
    <label className="field">
      <span className="field__label">
        {label}: <strong>{format(value)}</strong>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        // Screen readers read this instead of the raw number.
        aria-valuetext={format(value)}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}
