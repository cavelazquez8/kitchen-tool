import {
  isRecord,
  MAX_MEDIA_BYTES,
  MEDIA_TYPES,
  parseAiReply,
  parseChatRequest,
  parseExtractRequest,
  parseNutritionExtractRequest,
  parseAiNutritionReply,
} from './protocol';
import type {
  AiChatRequest,
  AiExtractRequest,
  AiMedia,
  AiReply,
  AiNutritionReply,
  GeminiConnection,
} from './protocol';

export type {
  AiChatRequest,
  AiExtractRequest,
  AiMedia,
  AiMessage,
  AiRecipeDraft,
  AiRecipeCandidate,
  AiNutritionReply,
  AiReply,
  GeminiConnection,
} from './protocol';

const CONNECTION_KEY = 'mise.gemini.connection.v1';
const CONNECTION_DRAFT_KEY = 'mise.gemini.connection-draft.v1';
const TIMEOUT_MS = 95_000;

export class GeminiError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'GeminiError';
  }
}

export function normalizeGeminiConnection(connection: GeminiConnection): GeminiConnection {
  const token = connection.token.trim();
  const address = connection.url.trim();
  let url: URL;
  try {
    // Cloudflare commonly displays the hostname without the HTTPS prefix.
    url = new URL(address.includes('://') ? address : `https://${address}`);
  } catch {
    throw new GeminiError(
      'settings',
      'Enter your full Worker address, such as https://mise-gemini.your-name.workers.dev.',
    );
  }
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (
    (!local && (url.protocol !== 'https:' || !url.hostname.endsWith('.workers.dev'))) ||
    (local && !['http:', 'https:'].includes(url.protocol)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new GeminiError(
      'settings',
      'Use your HTTPS workers.dev address, without an endpoint, query, or password.',
    );
  }
  if (!local && url.hostname.split('.').length < 4)
    throw new GeminiError(
      'settings',
      'Include the Worker name before your account name: mise-gemini.your-name.workers.dev.',
    );
  if (token.startsWith('AIza') || !/^[A-Za-z0-9_-]{32,128}$/.test(token))
    throw new GeminiError(
      'settings',
      'Enter the Mise access token stored in your Worker—not your Gemini API key.',
    );
  return { url: url.origin, token };
}

export function readGeminiConnection(): GeminiConnection | null {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(CONNECTION_KEY) ?? 'null');
    if (!isRecord(stored) || typeof stored.url !== 'string' || typeof stored.token !== 'string')
      return null;
    return normalizeGeminiConnection({ url: stored.url, token: stored.token });
  } catch {
    return null;
  }
}

export function saveGeminiConnection(connection: GeminiConnection): void {
  localStorage.setItem(CONNECTION_KEY, JSON.stringify(normalizeGeminiConnection(connection)));
  localStorage.removeItem(CONNECTION_DRAFT_KEY);
}

/** Keep unfinished setup separate from the connection used for actual AI requests. */
export function readGeminiConnectionDraft(): GeminiConnection | null {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(CONNECTION_DRAFT_KEY) ?? 'null');
    if (
      !isRecord(stored) ||
      typeof stored.url !== 'string' ||
      typeof stored.token !== 'string' ||
      stored.url.length > 2048 ||
      stored.token.length > 128 ||
      stored.token.trim().startsWith('AIza')
    )
      return null;
    return { url: stored.url, token: stored.token };
  } catch {
    return null;
  }
}

export function saveGeminiConnectionDraft(connection: GeminiConnection): void {
  // Pairing tokens may be kept locally; Google's API key must stay in Cloudflare.
  localStorage.setItem(
    CONNECTION_DRAFT_KEY,
    JSON.stringify({
      url: connection.url.slice(0, 2048),
      token: connection.token.trim().startsWith('AIza') ? '' : connection.token.slice(0, 128),
    }),
  );
}

export function clearGeminiConnection(): void {
  localStorage.removeItem(CONNECTION_KEY);
  localStorage.removeItem(CONNECTION_DRAFT_KEY);
}

export function generateGeminiAccessToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

async function readConnectionResponse(response: Response): Promise<string> {
  const maxBytes = 512 * 1024;
  const length = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(length) && length > maxBytes)
    throw new GeminiError('invalid_response', 'The AI connection returned too much data.');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = '';
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new GeminiError('invalid_response', 'The AI connection returned too much data.');
      }
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export async function requestMiseWorker(
  connection: GeminiConnection,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const configured = normalizeGeminiConnection(connection);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${configured.url}${path}`, {
      method: body ? 'POST' : 'GET',
      mode: 'cors',
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${configured.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    // The Worker limits output too; this guard also protects against a misconfigured endpoint.
    const raw = await readConnectionResponse(response);
    if (!response.ok && /(?:1102|exceeded (?:CPU time|resource) limits)/i.test(raw))
      throw new GeminiError(
        'resource_limit',
        'The free Worker could not process this file or page. Try a smaller/cropped image, shorter clip, or pasted recipe text.',
      );
    if (raw.length > 512 * 1024)
      throw new GeminiError('invalid_response', 'The AI connection returned too much data.');
    let result: unknown;
    try {
      result = JSON.parse(raw);
    } catch {
      throw new GeminiError(
        'invalid_response',
        'The Worker returned an unreadable response. Check the Worker URL.',
      );
    }
    if (!response.ok) {
      if (
        isRecord(result) &&
        isRecord(result.error) &&
        typeof result.error.code === 'string' &&
        typeof result.error.message === 'string'
      ) {
        const retryAfter = result.error.retryAfterSeconds;
        throw new GeminiError(
          result.error.code,
          result.error.message,
          typeof retryAfter === 'number' && Number.isFinite(retryAfter) ? retryAfter : undefined,
        );
      }
      throw new GeminiError('connection', 'The AI connection could not complete this request.');
    }
    return result;
  } catch (error) {
    if (error instanceof GeminiError) throw error;
    if (signal?.aborted) throw new GeminiError('cancelled', 'Request cancelled.');
    if (controller.signal.aborted)
      throw new GeminiError(
        'timeout',
        'Gemini took too long. Try a shorter message or a smaller file.',
      );
    throw new GeminiError(
      'connection',
      'Could not reach your AI connection. Check the Worker URL, allowed origin and internet connection.',
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

/** Tests Worker configuration and pairing without consuming Gemini quota. */
export async function checkGeminiConnection(
  connection: GeminiConnection,
  signal?: AbortSignal,
): Promise<{ ok: true; model: string }> {
  const result = await requestMiseWorker(connection, '/health', undefined, signal);
  if (!isRecord(result) || result.ok !== true || typeof result.model !== 'string')
    throw new GeminiError('invalid_response', 'This address did not respond as a Mise Worker.');
  return { ok: true, model: result.model };
}

export async function sendGeminiChat(
  connection: GeminiConnection,
  input: AiChatRequest,
  signal?: AbortSignal,
): Promise<AiReply> {
  const validated = parseChatRequest(input);
  if (!validated)
    throw new GeminiError(
      'invalid_request',
      'Use a shorter message or conversation. Clear older messages if needed.',
    );
  let raw: unknown;
  try {
    raw = await requestMiseWorker(connection, '/chat', validated, signal);
  } catch (error) {
    if (validated.candidates && error instanceof GeminiError && error.code === 'invalid_request')
      throw new GeminiError(
        'worker_update',
        'Update your Cloudflare Worker with the latest Mise Worker file to use recipe recommendations. Your saved recipes still work.',
      );
    throw error;
  }
  const result = parseAiReply(raw, validated.candidates);
  if (!result)
    throw new GeminiError('invalid_response', 'Gemini returned an answer Mise cannot safely save.');
  return result;
}

/** Extract stated daily recommendations for review; this never applies targets. */
export async function extractGeminiNutrition(
  connection: GeminiConnection,
  input: AiExtractRequest,
  signal?: AbortSignal,
): Promise<AiNutritionReply> {
  const validated = parseNutritionExtractRequest(input);
  if (!validated)
    throw new GeminiError(
      'invalid_request',
      'Paste your recommended daily targets or choose a JPG, PNG or WebP report image under 1 MB.',
    );
  let raw: unknown;
  try {
    raw = await requestMiseWorker(connection, '/nutrition/extract', validated, signal);
  } catch (error) {
    if (error instanceof GeminiError && error.code === 'not_found')
      throw new GeminiError(
        'worker_update',
        'Update your Cloudflare Worker with the latest Mise Worker file to extract nutrition reports. You can enter your targets manually now.',
      );
    throw error;
  }
  const result = parseAiNutritionReply(raw);
  if (!result)
    throw new GeminiError(
      'invalid_response',
      'Gemini returned nutritional values Mise cannot safely review. Enter the targets manually.',
    );
  return result;
}

export async function extractGeminiRecipe(
  connection: GeminiConnection,
  input: AiExtractRequest,
  signal?: AbortSignal,
): Promise<AiReply> {
  const validated = parseExtractRequest(input);
  if (!validated)
    throw new GeminiError(
      'invalid_request',
      'Add recipe text or a supported image/video under 1 MB. A link alone cannot be extracted.',
    );
  const result = parseAiReply(await requestMiseWorker(connection, '/extract', validated, signal));
  if (!result)
    throw new GeminiError('invalid_response', 'Gemini returned a recipe Mise cannot safely save.');
  return result;
}

export async function fileToGeminiMedia(file: File): Promise<AiMedia> {
  if (file.size === 0 || file.size > MAX_MEDIA_BYTES)
    throw new GeminiError('file_size', 'Choose an image or a short video under 1 MB.');
  if (!(MEDIA_TYPES as readonly string[]).includes(file.type))
    throw new GeminiError('file_type', 'Use a JPG, PNG, WebP image, or an MP4/WebM video.');
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string' || !reader.result.includes(','))
        reject(new GeminiError('file', 'This file could not be read.'));
      else resolve(reader.result.slice(reader.result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new GeminiError('file', 'This file could not be read.'));
    reader.onabort = () => reject(new GeminiError('cancelled', 'File reading cancelled.'));
    reader.readAsDataURL(file);
  });
  return { mimeType: file.type, data };
}

/** Import embedded Recipe JSON-LD without making a Gemini generation request. */
export async function importGeminiRecipeUrl(
  connection: GeminiConnection,
  url: string,
  signal?: AbortSignal,
): Promise<AiReply> {
  if (!url.trim() || url.length > 2000)
    throw new GeminiError('import_url', 'Enter a complete recipe website link.');
  const result = parseAiReply(
    await requestMiseWorker(connection, '/import', { url: url.trim() }, signal),
  );
  if (!result || !result.recipes.length)
    throw new GeminiError(
      'invalid_response',
      'The website did not return a recipe Mise can safely save.',
    );
  return result;
}
