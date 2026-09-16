/** Camera acquisition with error messages a blind user can act on. */

export class CameraError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'CameraError';
  }
}

export function isCameraSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  );
}

export async function openCamera(
  facing: 'environment' | 'user' = 'environment',
): Promise<MediaStream> {
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    /**
     * `localhost` is treated as secure; a LAN address like 192.168.1.20 is
     * not, so opening the dev server from a phone silently kills the camera.
     * Name both ways out, because "use HTTPS" alone is not actionable.
     */
    const onThisMachine = `Open http://localhost:${
      window.location.port || '5173'
    } instead`;
    throw new CameraError(
      `The camera needs a secure connection. ${onThisMachine}, or run the dev server with npm run dev:https to use this address.`,
      'insecure-context',
    );
  }

  if (!isCameraSupported()) {
    throw new CameraError(
      'This browser cannot access the camera.',
      'unsupported',
    );
  }

  try {
    return await navigator.mediaDevices.getUserMedia({
      video: {
        // `ideal` rather than `exact`: laptops have no rear camera and would
        // otherwise fail outright instead of falling back to the webcam.
        facingMode: { ideal: facing },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    });
  } catch (error) {
    throw toCameraError(error);
  }
}

function toCameraError(error: unknown): CameraError {
  const name = (error as { name?: string })?.name ?? '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return new CameraError(
        'Camera permission was denied. Allow camera access in your browser settings, then try again.',
        'denied',
      );
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return new CameraError('No camera was found on this device.', 'not-found');
    case 'NotReadableError':
    case 'TrackStartError':
      return new CameraError(
        'The camera is already in use by another app. Close it and try again.',
        'in-use',
      );
    case 'OverconstrainedError':
      return new CameraError(
        'This camera does not support the requested settings.',
        'overconstrained',
      );
    case 'SecurityError':
      return new CameraError(
        'The browser blocked camera access on this page.',
        'security',
      );
    default:
      return new CameraError('The camera could not be started.', 'unknown');
  }
}

/** Attaches a stream and resolves once frames are actually flowing. */
export async function attachStream(
  video: HTMLVideoElement,
  stream: MediaStream,
): Promise<void> {
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', 'true');

  if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
    await new Promise<void>((resolve) => {
      const onReady = () => {
        video.removeEventListener('loadedmetadata', onReady);
        resolve();
      };
      video.addEventListener('loadedmetadata', onReady);
      // Never hang the start-up path on a metadata event that never fires.
      window.setTimeout(onReady, 4000);
    });
  }

  try {
    await video.play();
  } catch {
    throw new CameraError(
      'The camera could not start playing. Tap the screen and try again.',
      'play-failed',
    );
  }
}

export function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}
