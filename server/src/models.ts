import { isGeminiModelId, isRecord } from '../../src/ai/protocol';
import type { GeminiModelCatalog, GeminiModelCatalogEntry } from '../../src/ai/models';
import { workerOutboundOptions } from './outbound';

export const MODEL_PRICING_URL = 'https://ai.google.dev/gemini-api/docs/pricing' as const;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const CACHE_MS = 60 * 60 * 1000;
const MAX_MODELS = 200;
const MAX_PAGES = 5;
const PAGE_SIZE = 200;
const TIMEOUT_MS = 20_000;
const MAX_CACHE_KEYS = 8;

export class ModelsError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

interface CatalogCache {
  catalog?: GeminiModelCatalog;
  expiresAt: number;
  pending?: Promise<GeminiModelCatalog>;
}

export interface ModelDiscoveryState {
  minute: { start: number; count: number };
  cache: Map<string, CatalogCache>;
}

export function createModelDiscoveryState(): ModelDiscoveryState {
  return { minute: { start: 0, count: 0 }, cache: new Map() };
}

function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_match, value: string) => {
      const code =
        value.startsWith('x') || value.startsWith('X')
          ? Number.parseInt(value.slice(1), 16)
          : Number(value);
      return code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

type PricingStatus = GeminiModelCatalogEntry['freeTier'];

/** Strictly reads the Standard Free Tier column; unknown layouts never grant access. */
export function parseModelPricing(html: string): Map<string, PricingStatus> {
  if (new TextEncoder().encode(html).byteLength > MAX_RESPONSE_BYTES)
    throw new ModelsError(502, 'models_pricing', 'Google’s pricing page is too large to verify.');
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const sections = cleaned.split(/<h2\b[^>]*>/i).slice(1);
  const result = new Map<string, PricingStatus>();
  for (const section of sections) {
    const firstHeading = section.search(/<h3\b/i);
    if (firstHeading < 0) continue;
    const ids = new Set(
      Array.from(section.slice(0, firstHeading).matchAll(/<code\b[^>]*>([^<]+)<\/code\s*>/gi))
        .map((match) => plainText(match[1]))
        .filter(isGeminiModelId),
    );
    if (!ids.size) continue;
    const standardTables: string[] = [];
    const headings = Array.from(section.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3\s*>/gi));
    headings.forEach((heading, index) => {
      if (plainText(heading[1]) !== 'Standard') return;
      const start = heading.index! + heading[0].length;
      const end = headings[index + 1]?.index ?? section.length;
      const content = section.slice(start, end).trim();
      const table = /^<table\b[^>]*>([\s\S]*?)<\/table\s*>/i.exec(content);
      if (table) standardTables.push(table[1]);
    });
    let status: PricingStatus = 'unknown';
    if (standardTables.length === 1 && !/\b(?:colspan|rowspan)\s*=/i.test(standardTables[0])) {
      const table = standardTables[0];
      const header = /<thead\b[^>]*>([\s\S]*?)<\/thead\s*>/i.exec(table);
      const headRows = header
        ? Array.from(header[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi))
        : [];
      const headers =
        headRows.length === 1
          ? Array.from(headRows[0][1].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th\s*>/gi)).map((cell) =>
              plainText(cell[1]),
            )
          : [];
      const freeIndex = headers.indexOf('Free Tier');
      const body = /<tbody\b[^>]*>([\s\S]*?)<\/tbody\s*>/i.exec(table);
      const prices: string[] = [];
      let inputCount = 0;
      let outputCount = 0;
      if (freeIndex > 0 && headers.lastIndexOf('Free Tier') === freeIndex && body) {
        for (const row of body[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
          const cells = Array.from(row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td\s*>/gi)).map(
            (cell) => plainText(cell[1]),
          );
          if (cells.length !== headers.length) continue;
          if (/^Input price(?: \([^)]*\))?$/.test(cells[0])) {
            inputCount++;
            prices.push(cells[freeIndex]);
          }
          if (/^Output price(?: \([^)]*\))?$/.test(cells[0])) {
            outputCount++;
            prices.push(cells[freeIndex]);
          }
        }
        if (inputCount === 1 && outputCount === 1) {
          if (prices.every((price) => price === 'Free of charge')) status = 'verified';
          else if (prices.some((price) => price === 'Not available')) status = 'unavailable';
        }
      }
    }
    for (const id of ids) result.set(id, result.has(id) ? 'unknown' : status);
  }
  return result;
}

function eligibleModel(value: unknown): GeminiModelCatalogEntry | null {
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name.startsWith('models/'))
    return null;
  const id = value.name.slice(7);
  if (
    !isGeminiModelId(id) ||
    /(?:^|-)(?:live|tts|transcribe|image|embedding|robotics|music|audio)(?:-|$)/.test(id)
  )
    return null;
  if (
    !Array.isArray(value.supportedGenerationMethods) ||
    !value.supportedGenerationMethods.includes('generateContent')
  )
    return null;
  const limit = (number: unknown): number | null =>
    typeof number === 'number' && Number.isSafeInteger(number) && number > 0 ? number : null;
  return {
    id,
    name:
      typeof value.displayName === 'string' && value.displayName.trim()
        ? value.displayName.slice(0, 128)
        : id,
    description: typeof value.description === 'string' ? value.description.slice(0, 1200) : '',
    inputTokenLimit: limit(value.inputTokenLimit),
    outputTokenLimit: limit(value.outputTokenLimit),
    freeTier: 'unknown',
  };
}

async function boundedText(response: Response): Promise<string> {
  const declared = response.headers.get('Content-Length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel();
    throw new ModelsError(502, 'models_response', 'Google returned too much model information.');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ModelsError(
          502,
          'models_response',
          'Google returned too much model information.',
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function fetchText(fetcher: typeof fetch, url: string, apiKey?: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetcher(url, {
      method: 'GET',
      redirect: 'manual',
      ...workerOutboundOptions(
        {
          Accept: apiKey ? 'application/json' : 'text/html',
          ...(apiKey ? { 'x-goog-api-key': apiKey } : { 'Accept-Language': 'en' }),
        },
        controller.signal,
      ),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ModelsError(
        [401, 403].includes(response.status) ? 503 : 502,
        [401, 403].includes(response.status) && apiKey ? 'configuration' : 'models_upstream',
        apiKey && [401, 403].includes(response.status)
          ? 'Google rejected the Worker’s API key for model discovery. Check AI Studio.'
          : 'Google’s model or pricing information could not be reached. Try refreshing later.',
      );
    }
    return await boundedText(response);
  } catch (error) {
    if (error instanceof ModelsError) throw error;
    throw new ModelsError(
      502,
      'models_upstream',
      'Google’s model or pricing information could not be reached. Try refreshing later.',
    );
  } finally {
    clearTimeout(timer);
  }
}

async function loadCatalog(
  apiKey: string,
  fetcher: typeof fetch,
  now: () => number,
): Promise<GeminiModelCatalog> {
  const models = new Map<string, GeminiModelCatalogEntry>();
  let pageToken: string | undefined;
  const seenTokens = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL('https://generativelanguage.googleapis.com/v1beta/models');
    url.searchParams.set('pageSize', String(PAGE_SIZE));
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    let data: unknown;
    try {
      data = JSON.parse(await fetchText(fetcher, url.href, apiKey));
    } catch (error) {
      if (error instanceof ModelsError) throw error;
      throw new ModelsError(
        502,
        'models_response',
        'Google returned unreadable model information.',
      );
    }
    if (!isRecord(data) || !Array.isArray(data.models) || data.models.length > PAGE_SIZE)
      throw new ModelsError(
        502,
        'models_response',
        'Google returned incomplete model information.',
      );
    for (const item of data.models) {
      const model = eligibleModel(item);
      if (model) models.set(model.id, model);
    }
    if (models.size > MAX_MODELS)
      throw new ModelsError(
        502,
        'models_response',
        'Google’s model list exceeds Mise’s review limit.',
      );
    if (data.nextPageToken === undefined) break;
    if (
      typeof data.nextPageToken !== 'string' ||
      !data.nextPageToken ||
      data.nextPageToken.length > 1000 ||
      seenTokens.has(data.nextPageToken) ||
      page === MAX_PAGES - 1
    )
      throw new ModelsError(
        502,
        'models_response',
        'Google’s model list could not be fully checked.',
      );
    pageToken = data.nextPageToken;
    seenTokens.add(pageToken);
  }
  let prices = new Map<string, PricingStatus>();
  const warnings: string[] = [];
  try {
    prices = parseModelPricing(await fetchText(fetcher, `${MODEL_PRICING_URL}?hl=en`));
    if (!prices.size)
      warnings.push(
        'Google’s pricing page could not be interpreted. New models stay disabled until their free tier can be verified.',
      );
  } catch {
    warnings.push(
      'Google’s current pricing could not be checked. New models stay disabled; refresh to try again.',
    );
  }
  return {
    models: Array.from(models.values())
      .map((model) => ({ ...model, freeTier: prices.get(model.id) ?? 'unknown' }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    checkedAt: new Date(now()).toISOString(),
    pricingUrl: MODEL_PRICING_URL,
    warnings,
  };
}

export async function discoverGeminiModels(
  apiKey: string,
  state: ModelDiscoveryState,
  fetcher: typeof fetch,
  now: () => number,
  refresh = false,
): Promise<GeminiModelCatalog> {
  const time = now();
  if (time - state.minute.start >= 60_000) state.minute = { start: time, count: 0 };
  if (state.minute.count >= 10)
    throw new ModelsError(
      429,
      'models_rate_limit',
      'Please wait a moment before checking models again.',
      Math.max(1, Math.ceil((state.minute.start + 60_000 - time) / 1000)),
    );
  state.minute.count++;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(apiKey));
  const key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
  let entry = state.cache.get(key);
  if (entry?.pending) return entry.pending;
  if (!refresh && entry?.catalog && time < entry.expiresAt) return entry.catalog;
  if (!entry) {
    if (state.cache.size >= MAX_CACHE_KEYS) {
      const oldest = Array.from(state.cache).find(([, item]) => !item.pending);
      if (oldest) state.cache.delete(oldest[0]);
      else
        throw new ModelsError(
          429,
          'models_busy',
          'Model checks are already running. Please wait.',
          10,
        );
    }
    entry = { expiresAt: 0 };
    state.cache.set(key, entry);
  }
  // A refresh invalidates prior verification before network work; failures cannot authorize stale models.
  entry.catalog = undefined;
  entry.expiresAt = 0;
  const current = entry;
  current.pending = loadCatalog(apiKey, fetcher, now);
  try {
    const catalog = await current.pending;
    current.catalog = catalog;
    current.expiresAt = now() + CACHE_MS;
    return catalog;
  } finally {
    current.pending = undefined;
  }
}

export async function authorizeDiscoveredModel(
  model: string,
  reviewed: unknown,
  apiKey: string,
  state: ModelDiscoveryState,
  fetcher: typeof fetch,
  now: () => number,
): Promise<void> {
  if (!isGeminiModelId(model) || reviewed !== true)
    throw new ModelsError(
      403,
      'model_unverified',
      'Review and select this model in Mise’s Gemini settings first.',
    );
  const catalog = await discoverGeminiModels(apiKey, state, fetcher, now);
  if (!catalog.models.some((entry) => entry.id === model && entry.freeTier === 'verified'))
    throw new ModelsError(
      403,
      'model_unverified',
      'This model’s current free tier could not be verified. Refresh models or choose a supported free model.',
    );
}
