import { GoogleAuth } from 'google-auth-library';

import { env } from './env.js';
import type { Provider } from './env.js';

export interface VertexTarget {
  project: string;
  location: string;
}

/** The generateContent URL for a model on the given provider. */
export function buildEndpoint(
  provider: Provider,
  model: string,
  { project, location }: VertexTarget,
): string {
  const id = encodeURIComponent(model);
  if (provider === 'aistudio') {
    return `https://generativelanguage.googleapis.com/v1beta/models/${id}:generateContent`;
  }
  const host =
    location === 'global'
      ? 'aiplatform.googleapis.com'
      : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${id}:generateContent`;
}

/**
 * Application Default Credentials: the service account on Cloud Run, or
 * `gcloud auth application-default login` on a developer machine. No key
 * ever lives in the repo or the environment.
 */
let auth: GoogleAuth | null = null;

export async function authHeaders(): Promise<Record<string, string>> {
  if (env.provider === 'aistudio') {
    return { 'x-goog-api-key': env.geminiApiKey };
  }
  auth ??= new GoogleAuth({
    scopes: 'https://www.googleapis.com/auth/cloud-platform',
  });
  const token = await auth.getAccessToken();
  if (!token) throw new Error('No Google Cloud access token available.');
  return { Authorization: `Bearer ${token}` };
}

export function isVisionConfigured(): boolean {
  return env.provider === 'vertex'
    ? env.gcpProject.length > 0
    : env.geminiApiKey.length > 0;
}

export function endpointFor(model: string): string {
  return buildEndpoint(env.provider, model, {
    project: env.gcpProject,
    location: env.vertexLocation,
  });
}
