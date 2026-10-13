import { isGeminiModelId, isRecord } from './protocol';

export const GEMINI_PRICING_URL = 'https://ai.google.dev/gemini-api/docs/pricing' as const;
export const MAX_GEMINI_CATALOG_MODELS = 200;

export interface GeminiModelCatalogEntry {
  id: string;
  name: string;
  description: string;
  inputTokenLimit: number | null;
  outputTokenLimit: number | null;
  freeTier: 'verified' | 'unavailable' | 'unknown';
}

export interface GeminiModelCatalog {
  models: GeminiModelCatalogEntry[];
  checkedAt: string;
  pricingUrl: typeof GEMINI_PRICING_URL;
  warnings: string[];
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function boundedText(value: unknown, max: number, allowEmpty = false): value is string {
  return (
    typeof value === 'string' && value.length <= max && (allowEmpty || value.trim().length > 0)
  );
}

function tokenLimit(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
}

function checkedTimestamp(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  )
    return false;
  const date = new Date(value);
  return (
    Number.isFinite(date.getTime()) &&
    (date.toISOString() === value || date.toISOString().replace('.000Z', 'Z') === value)
  );
}

/** Treat a catalog as availability information, never as permission to charge or generate. */
export function parseGeminiModelCatalog(value: unknown): GeminiModelCatalog | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ['models', 'checkedAt', 'pricingUrl', 'warnings']) ||
    !Array.isArray(value.models) ||
    value.models.length > MAX_GEMINI_CATALOG_MODELS ||
    !checkedTimestamp(value.checkedAt) ||
    value.pricingUrl !== GEMINI_PRICING_URL ||
    !Array.isArray(value.warnings) ||
    value.warnings.length > 20 ||
    !value.warnings.every((warning) => boundedText(warning, 1000))
  )
    return null;
  const models: GeminiModelCatalogEntry[] = [];
  const ids = new Set<string>();
  for (const entry of value.models) {
    if (
      !isRecord(entry) ||
      !onlyKeys(entry, [
        'id',
        'name',
        'description',
        'inputTokenLimit',
        'outputTokenLimit',
        'freeTier',
      ]) ||
      !isGeminiModelId(entry.id) ||
      ids.has(entry.id) ||
      !boundedText(entry.name, 200) ||
      !boundedText(entry.description, 2000, true) ||
      !tokenLimit(entry.inputTokenLimit) ||
      !tokenLimit(entry.outputTokenLimit) ||
      typeof entry.freeTier !== 'string' ||
      !['verified', 'unavailable', 'unknown'].includes(String(entry.freeTier))
    )
      return null;
    ids.add(entry.id);
    models.push({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      inputTokenLimit: entry.inputTokenLimit,
      outputTokenLimit: entry.outputTokenLimit,
      freeTier: entry.freeTier as GeminiModelCatalogEntry['freeTier'],
    });
  }
  return {
    models,
    checkedAt: value.checkedAt,
    pricingUrl: value.pricingUrl,
    warnings: value.warnings as string[],
  };
}
