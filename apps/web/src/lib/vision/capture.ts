/**
 * Grabs a still from the live video and encodes it for the vision API.
 *
 * 640 px on the long edge is a deliberate choice: Gemini downsamples large
 * images anyway, and every extra kilobyte is upload latency on a phone's
 * mobile connection. Smaller frames measurably shorten time-to-speech.
 */

const MAX_DIMENSION = 640;
const JPEG_QUALITY = 0.72;

export interface CapturedFrame {
  base64: string;
  mimeType: 'image/jpeg';
  width: number;
  height: number;
  sizeKb: number;
}

let canvas: HTMLCanvasElement | null = null;

function getCanvas(): HTMLCanvasElement {
  if (!canvas) canvas = document.createElement('canvas');
  return canvas;
}

export function captureFrame(
  video: HTMLVideoElement,
  maxDimension = MAX_DIMENSION,
  quality = JPEG_QUALITY,
): CapturedFrame | null {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (!sourceWidth || !sourceHeight) return null;

  const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
  const width = Math.round(sourceWidth * scale);
  const height = Math.round(sourceHeight * scale);

  const target = getCanvas();
  target.width = width;
  target.height = height;

  const ctx = target.getContext('2d');
  if (!ctx) return null;

  try {
    ctx.drawImage(video, 0, 0, width, height);
  } catch {
    return null;
  }

  let dataUrl: string;
  try {
    dataUrl = target.toDataURL('image/jpeg', quality);
  } catch {
    // Tainted canvas — should not happen with getUserMedia, but never throw
    // out of the capture path.
    return null;
  }

  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  if (!base64) return null;

  return {
    base64,
    mimeType: 'image/jpeg',
    width,
    height,
    sizeKb: Math.round((base64.length * 3) / 4 / 1024),
  };
}
