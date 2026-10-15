import { useEffect, useState } from 'react';

/** Minimal shape of the browser's install event (not in the DOM lib). */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** True when running as an installed PWA (standalone) rather than a browser tab. */
export function isInstalled(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  // iOS Safari: no beforeinstallprompt, this is the only signal.
  return (window.navigator as unknown as { standalone?: boolean }).standalone === true;
}

/**
 * "Add Blind View to Home Screen" card.
 *
 * Shown only in a browser tab, never when installed. Dismissible, never
 * blocks Start. Android: uses beforeinstallprompt when the browser offers
 * it. iOS: shows the 3 manual steps (Safari has no install event). The
 * spoken hint ("say Hey Siri / Hey Google, open Blind View") is spoken once
 * from App's first-gesture greeting — a card alone cannot speak before a
 * gesture, and we never claim a voice assistant will open a website that
 * is not installed.
 */
export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(isInstalled());
  const [dismissed, setDismissed] = useState(false);
  const [prompted, setPrompted] = useState(false);

  useEffect(() => {
    const onBeforeInstall = (e: Event) => {
      // Hold the event so our own button can trigger the install sheet.
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (installed || dismissed) return null;

  const install = async () => {
    if (!deferred) return;
    setPrompted(true);
    try {
      await deferred.prompt();
      await deferred.userChoice;
    } catch { /* user closed the sheet: manual steps below still apply */ }
    setDeferred(null);
  };

  return (
    <section className="panel install" aria-label="Add Blind View to Home Screen" data-no-toggle>
      <h2 className="panel__heading">Add Blind View to Home Screen</h2>
      <p className="install__text">
        Once it&apos;s on your Home Screen, you can say Hey Siri or Hey Google,
        open Blind View.
      </p>
      {deferred && !prompted ? (
        <button type="button" className="btn btn--primary" onClick={() => void install()}>
          Install app
        </button>
      ) : (
        <ol className="install__steps">
          <li>Tap Share</li>
          <li>then Add to Home Screen</li>
          <li>then Open Blind View</li>
        </ol>
      )}
      <button type="button" className="btn btn--ghost" onClick={() => setDismissed(true)}>
        Skip
      </button>
    </section>
  );
}
