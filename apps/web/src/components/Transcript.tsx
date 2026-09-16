import { useSession } from '../store/session';

const SOURCE_LABEL: Record<string, string> = {
  hazard: 'Hazard',
  guide: 'Guide',
  place: 'Place',
  scene: 'Scene',
  text: 'Text',
  find: 'Find',
  currency: 'Money',
  ask: 'Answer',
  system: 'System',
};

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * A visual log of everything spoken.
 *
 * Blind users get this information through the speaker, not the screen — this
 * exists for sighted helpers, for developers tuning thresholds, and for users
 * with partial vision who want to re-read something they missed.
 */
export function Transcript() {
  const transcript = useSession((state) => state.transcript);

  if (transcript.length === 0) {
    return (
      <p className="transcript__empty">
        Nothing spoken yet. Start Blind View to begin.
      </p>
    );
  }

  return (
    <ol className="transcript" aria-label="Spoken history">
      {transcript.map((entry) => (
        <li key={entry.id} className={`transcript__item transcript__item--${entry.source}`}>
          <span className="transcript__meta">
            <span className="transcript__source">
              {SOURCE_LABEL[entry.source] ?? entry.source}
            </span>
            <time dateTime={new Date(entry.at).toISOString()}>{timeOf(entry.at)}</time>
          </span>
          <span className="transcript__text">{entry.text}</span>
        </li>
      ))}
    </ol>
  );
}
