import { parseGeminiModelCatalog, type GeminiModelCatalog } from './models';
import { isGeminiModelId, isRecord } from './protocol';

const PREFERENCES_KEY = 'mise.gemini.models.v1';
const MAX_REVIEWED_MODELS = 200;
const CATALOG_LIFETIME_MS = 60 * 60 * 1000;
const CLOCK_TOLERANCE_MS = 5000;

export interface ModelPreferences {
  catalog: GeminiModelCatalog | null;
  reviewedIds: string[];
}

interface StoredModelPreferences extends ModelPreferences {
  url: string;
}

function emptyPreferences(): ModelPreferences {
  return { catalog: null, reviewedIds: [] };
}

/** Accept the same root Worker address forms as connection setup, never query secrets. */
function normalizeWorkerUrl(value: string): string | null {
  try {
    const address = value.trim();
    const url = new URL(address.includes('://') ? address : `https://${address}`);
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      (local && !['http:', 'https:'].includes(url.protocol)) ||
      (!local &&
        (url.protocol !== 'https:' ||
          !url.hostname.endsWith('.workers.dev') ||
          url.hostname.split('.').length < 4))
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Corrupt or differently paired records are ignored without changing stored data. */
export function readModelPreferences(url: string): ModelPreferences {
  const normalizedUrl = normalizeWorkerUrl(url);
  if (!normalizedUrl) return emptyPreferences();
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? 'null');
    if (
      !isRecord(stored) ||
      Object.keys(stored).some((key) => !['url', 'catalog', 'reviewedIds'].includes(key)) ||
      typeof stored.url !== 'string' ||
      stored.url !== normalizedUrl ||
      !Array.isArray(stored.reviewedIds) ||
      stored.reviewedIds.length > MAX_REVIEWED_MODELS ||
      !stored.reviewedIds.every(isGeminiModelId) ||
      new Set(stored.reviewedIds).size !== stored.reviewedIds.length
    )
      return emptyPreferences();
    const catalog = stored.catalog === null ? null : parseGeminiModelCatalog(stored.catalog);
    if (stored.catalog !== null && !catalog) return emptyPreferences();
    return { catalog, reviewedIds: [...stored.reviewedIds] };
  } catch {
    return emptyPreferences();
  }
}

function storePreferences(url: string, preferences: ModelPreferences): void {
  const normalizedUrl = normalizeWorkerUrl(url);
  if (!normalizedUrl)
    throw new Error('Save a valid Worker address before reviewing Gemini models.');
  const stored: StoredModelPreferences = { url: normalizedUrl, ...preferences };
  // Let quota or unavailable-storage errors reach the caller instead of claiming a saved review.
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify(stored));
}

export function saveModelCatalog(url: string, catalog: GeminiModelCatalog): void {
  const validated = parseGeminiModelCatalog(catalog);
  if (!validated)
    throw new Error('This Gemini model list could not be saved. Refresh models again.');
  const preferences = readModelPreferences(url);
  storePreferences(url, { ...preferences, catalog: validated });
}

/** An explicit pricing review is a local preference, never a Google billing authorization. */
export function reviewGeminiModel(url: string, id: string): void {
  if (!isGeminiModelId(id))
    throw new Error('Choose a valid Gemini model before confirming its review.');
  const preferences = readModelPreferences(url);
  if (preferences.reviewedIds.includes(id)) return;
  if (preferences.reviewedIds.length >= MAX_REVIEWED_MODELS)
    throw new Error(
      'Too many Gemini model reviews are saved. Disconnect and reconnect to start fresh.',
    );
  storePreferences(url, { ...preferences, reviewedIds: [...preferences.reviewedIds, id] });
}

export function forgetModelPreferences(): void {
  localStorage.removeItem(PREFERENCES_KEY);
}

export function isModelCatalogFresh(catalog: GeminiModelCatalog, now = Date.now()): boolean {
  const checkedAt = Date.parse(catalog.checkedAt);
  if (!Number.isFinite(checkedAt) || !Number.isFinite(now)) return false;
  const age = now - checkedAt;
  return age >= -CLOCK_TOLERANCE_MS && age < CATALOG_LIFETIME_MS;
}
