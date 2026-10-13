import { useState, useEffect, useCallback } from 'react';
import type { ChangeEvent } from 'react';

import { audioEngine, AudioEngineState } from '../lib/audio/AudioEngine';

export function PlaybackControls() {
  const [isPaused, setIsPaused] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [, setIsSpeaking] = useState(false);

  // Update UI based on audio engine state changes
  const updateUIState = useCallback((state: AudioEngineState) => {
    setIsPaused(state.paused);
    setIsMuted(state.muted);
    setVolume(state.volume);
    setIsSpeaking(state.speaking);
  }, []);

  // Listen for audio engine events for real-time updates
  useEffect(() => {
    // Initialize from current state
    updateUIState({
      paused: audioEngine.isPaused,
      muted: audioEngine.isMuted,
      volume: audioEngine.getVolume(),
      speaking: audioEngine.isSpeaking()
    });

    // Subscribe to state changes from AudioEngine
    const unsubscribe = audioEngine.onStateChanged(updateUIState);
    
    // Clean up
    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [updateUIState]);

  const togglePause = () => {
    if (isPaused) {
      audioEngine.resume();
    } else {
      audioEngine.pause();
    }
  };

  const toggleMute = () => {
    const newMuted = !isMuted;
    audioEngine.setMuted(newMuted);
    setIsMuted(newMuted);
  };

  const handleVolumeChange = (e: ChangeEvent<HTMLInputElement>) => {
    const newVolume = parseFloat(e.target.value);
    audioEngine.setVolume(newVolume);
    setVolume(newVolume);
  };

  return (
    <div className="playback-controls">
      <button
        type="button"
        className={`btn btn--icon ${isPaused ? 'btn--play' : 'btn--pause'}`}
        onClick={togglePause}
        aria-label={isPaused ? 'Resume playing' : 'Pause playback'}
      >
        {isPaused ? '▶' : '⏸'}
      </button>
      
      <button
        type="button"
        className={`btn btn--icon ${isMuted ? 'btn--mute' : 'btn--unmute'}`}
        onClick={toggleMute}
        aria-label={isMuted ? 'Unmute' : 'Mute'}
      >
        {isMuted ? '🔇' : '🔈'}
      </button>
      
      <div className="volume-control">
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={volume}
          onChange={handleVolumeChange}
          aria-label="Volume control"
        />
      </div>
    </div>
  );
}