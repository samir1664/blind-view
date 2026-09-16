import type { NarrationMode, PlaceContext, Verbosity } from '../../types';
import type { CapturedFrame } from '../vision/capture';

/**
 * Client for our own proxy. The Gemini key lives on the server and is never
 * shipped to the browser — a key in client-side JavaScript gets scraped and
 * billed to you within hours.
 */

export class NarrationError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    /** Server-requested wait before trying again, in seconds. */
    readonly retryAfterSec = 0,
  ) {
    super(message);
    this.name = 'NarrationError';
  }
}

export interface DescribeRequest {
  frame: CapturedFrame;
  mode: NarrationMode;
  verbosity: Verbosity;
  query?: string;
  /** Recent lines, so the model does not repeat itself. */
  recent?: string[];
  /** On-device detections for this frame, used as a hint. */
  detections?: string[];
  /** Where the user is, so the model uses the right vocabulary and hazards. */
  place?: PlaceContext | null;
  signal?: AbortSignal;
}

export interface DescribeResult {
  text: string;
  mode: NarrationMode;
  latencyMs: number;
}

export async function describeFrame({
  frame,
  mode,
  verbosity,
  query,
  recent,
  detections,
  place,
  signal,
}: DescribeRequest): Promise<DescribeResult> {
  let response: Response;

  try {
    response = await fetch('/api/describe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageBase64: frame.base64,
        mimeType: frame.mimeType,
        mode,
        verbosity,
        query,
        recent,
        detections,
        place,
      }),
      signal,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new NarrationError('No connection to the description service.', 0, true);
  }

  const payload = (await response.json().catch(() => ({}))) as {
    text?: string;
    mode?: NarrationMode;
    latencyMs?: number;
    error?: string;
    retryable?: boolean;
  };

  if (!response.ok || !payload.text) {
    throw new NarrationError(
      payload.error ?? 'Description failed.',
      response.status,
      payload.retryable ?? response.status >= 500,
      Number(response.headers.get('Retry-After')) || 0,
    );
  }

  return {
    text: payload.text,
    mode: payload.mode ?? mode,
    latencyMs: payload.latencyMs ?? 0,
  };
}

export interface HealthResult {
  ok: boolean;
  visionConfigured: boolean;
  model?: string;
}
export async function checkHealth(): Promise<HealthResult> {
  try {
    const response = await fetch('/api/health');
    if (!response.ok) return { ok: false, visionConfigured: false };
    return (await response.json()) as HealthResult;
  } catch {
    return { ok: false, visionConfigured: false };
  }
}

export interface ClassifyPlaceRequest {
  frame: CapturedFrame;
  /** Last known place, so the classifier stays stable instead of flip-flopping. */
  previous?: PlaceContext | null;
  detections?: string[];
  signal?: AbortSignal;
}

/**
 * Ask which kind of place this is: indoor > mall > escalator landing.
 *
 * Deliberately a separate endpoint from narration, on a much slower cadence.
 * The place rarely changes, so paying for it every few seconds would be waste.
 */
export async function classifyPlace({
  frame,
  previous,
  detections,
  signal,
}: ClassifyPlaceRequest): Promise<PlaceContext> {
  let response: Response;

  try {
    response = await fetch('/api/place', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageBase64: frame.base64,
        mimeType: frame.mimeType,
        detections,
        place: previous,
      }),
      signal,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new NarrationError('No connection to the description service.', 0, true);
  }

  const payload = (await response.json().catch(() => ({}))) as {
    place?: PlaceContext;
    error?: string;
    retryable?: boolean;
  };

  if (!response.ok || !payload.place) {
    throw new NarrationError(
      payload.error ?? 'Place detection failed.',
      response.status,
      payload.retryable ?? response.status >= 500,
      Number(response.headers.get('Retry-After')) || 0,
    );
  }

  return payload.place;
}
