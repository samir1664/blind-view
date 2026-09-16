import { useState } from 'react';

import { audioEngine, Priority } from '../lib/audio/AudioEngine';
import { useSettings } from '../store/settings';

const DISCLAIMER_SPOKEN =
  'Important. Blind View is an assistive aid only. It can miss obstacles, ' +
  'misjudge distance, and it cannot see everything. It is not a replacement ' +
  'for a white cane, a guide dog, or your own judgement. Never rely on it ' +
  'alone to cross a road or avoid danger. Continue to use your normal ' +
  'mobility aids at all times.';

/**
 * Hard gate before the app can be used.
 *
 * This is not legal boilerplate to click past — over-trusting an imperfect
 * detector is the realistic way someone gets hurt with software like this.
 * The wording is deliberately blunt, and it is available as speech because
 * the people who most need to hear it cannot read it.
 */
export function Disclaimer() {
  const acceptDisclaimer = useSettings((state) => state.acceptDisclaimer);
  const [reading, setReading] = useState(false);

  const readAloud = async () => {
    setReading(true);
    await audioEngine.unlock();
    audioEngine.speak({
      text: DISCLAIMER_SPOKEN,
      priority: Priority.INFO,
      source: 'system',
    });
  };

  const accept = async () => {
    await audioEngine.unlock();
    audioEngine.stopAll();
    acceptDisclaimer();
  };

  return (
    <main className="screen screen--disclaimer">
      <h1 className="disclaimer__title">Before you start</h1>

      <div className="disclaimer__body">
        <p className="disclaimer__lead">
          Blind View is an <strong>assistive aid only</strong>.
        </p>
        <ul className="disclaimer__list">
          <li>It can miss obstacles and misjudge distances.</li>
          <li>It does not see everything in front of you.</li>
          <li>
            It is <strong>not</strong> a replacement for a white cane, a guide
            dog, or your own judgement.
          </li>
          <li>Never rely on it alone to cross a road or avoid danger.</li>
        </ul>
        <p className="disclaimer__lead">
          Keep using your normal mobility aids at all times.
        </p>
      </div>

      <div className="disclaimer__actions">
        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => void readAloud()}
        >
          {reading ? 'Reading aloud…' : 'Read this aloud'}
        </button>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void accept()}
        >
          I understand — continue
        </button>
      </div>
    </main>
  );
}
