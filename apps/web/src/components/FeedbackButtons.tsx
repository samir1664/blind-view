import { useState } from 'react';

import { authHeaders } from '../lib/firebase';
import { useSession } from '../store/session';

/**
 * Anonymous "Was this description helpful?" — Yes / No.
 *
 * Shows only after something has been spoken (transcript non-empty).
 * Fire-and-forget fetch: never interrupts narration or speech, never blocks
 * the UI, and a failed send is silently dropped — the vote is still counted
 * locally so the buttons do not nag.
 */
export function FeedbackButtons() {
  const transcriptLength = useSession((state) => state.transcript.length);
  const placeCategory = useSession((state) => state.place?.category);
  const [voted, setVoted] = useState(false);
  const [sending, setSending] = useState(false);

  if (transcriptLength === 0) return null;

  const send = async (helpful: boolean) => {
    if (voted || sending) return;
    setSending(true);
    setVoted(true);
    try {
      await fetch('/api/feedback', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(await authHeaders()),
        },
        body: JSON.stringify({ helpful, placeCategory }),
      });
    } catch {
      // Feedback must never disturb the user.
    } finally {
      setSending(false);
    }
  };

  if (voted) {
    return (
      <p className="feedback__thanks" role="status">
        Thanks for your feedback.
      </p>
    );
  }

  return (
    <div className="feedback" aria-label="Was this description helpful?">
      <p className="feedback__question">Was this description helpful?</p>
      <div className="feedback__buttons">
        <button
          type="button"
          className="btn btn--action"
          onClick={() => void send(true)}
        >
          Yes, helpful
        </button>
        <button
          type="button"
          className="btn btn--action"
          onClick={() => void send(false)}
        >
          No, not helpful
        </button>
      </div>
    </div>
  );
}
