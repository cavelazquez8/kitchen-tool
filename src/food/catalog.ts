import { FOOD_CATALOG } from '../recipes/catalog';
import { publicUrl } from '../lib/publicUrl';

const URL = publicUrl('data/food-ingredients.json');
const CACHE_KEY = 'mise.food-catalog.v1';
const MAX_BYTES = 512_000;
const MAX_NAMES = 15_000;
let cached: readonly string[] | null = null;
let pending: Promise<readonly string[]> | null = null;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validNames(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_NAMES &&
    value.every(
      (name) =>
        typeof name === 'string' &&
        name.length >= 2 &&
        name.length <= 120 &&
        !/[<>\r\n]/.test(name),
    )
  );
}
export function foodSearchKey(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('en')
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
/** Stable ranking keeps recent/common foods first; words can be entered in any order. */
export function searchFoodNames(query: string, names: readonly string[], limit = 12): string[] {
  const term = foodSearchKey(query);
  const tokens = term.split(' ').filter(Boolean);
  const unique = new Map<string, { name: string; score: number; index: number }>();
  names.forEach((name, index) => {
    const key = foodSearchKey(name);
    if (!key || unique.has(key) || !tokens.every((token) => key.includes(token))) return;
    const score =
      key === term
        ? 0
        : key.startsWith(term)
          ? 1
          : tokens.every((token) => key.split(' ').some((word) => word.startsWith(token)))
            ? 2
            : 3;
    unique.set(key, { name, score, index });
  });
  return [...unique.values()]
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .slice(0, Math.max(0, Math.min(100, limit)))
    .map((entry) => entry.name);
}
export function combineFoodNames(
  extra: readonly string[],
  recent: readonly string[] = [],
): string[] {
  const names = new Map<string, string>();
  for (const name of [...recent, ...FOOD_CATALOG, ...extra]) {
    const key = foodSearchKey(name);
    if (key && !names.has(key)) names.set(key, name);
  }
  return [...names.values()];
}
/** The deployed snapshot has no API quota; downloaded names also survive offline reloads. */
export async function loadFoodNames(fetcher: typeof fetch = fetch): Promise<readonly string[]> {
  if (cached) return cached;
  if (pending) return pending;
  let saved: string[] | null = null;
  try {
    const value: unknown = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null');
    if (record(value) && validNames(value.names)) {
      saved = value.names;
      if (typeof value.savedAt === 'number' && Date.now() - value.savedAt < 7 * 86400_000) {
        cached = saved;
        return saved;
      }
    }
  } catch {
    /* Browser storage can be unavailable; adding items still works. */
  }
  pending = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetcher(URL, {
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-cache',
        signal: controller.signal,
      });
      if (
        !response.ok ||
        Number(response.headers.get('Content-Length')) > MAX_BYTES ||
        !response.body
      )
        throw new Error('Food suggestions unavailable.');
      const reader = response.body.getReader();
      let bytes = 0,
        raw = '';
      const decoder = new TextDecoder();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_BYTES) {
            await reader.cancel();
            throw new Error('Food suggestions unavailable.');
          }
          raw += decoder.decode(chunk.value, { stream: true });
        }
      } finally {
        reader.releaseLock();
      }
      const payload: unknown = JSON.parse(raw + decoder.decode());
      if (!record(payload) || payload.version !== 1 || !validNames(payload.names))
        throw new Error('Food suggestions unavailable.');
      cached = payload.names;
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ names: cached, savedAt: Date.now() }));
      } catch {
        /* Inventory takes priority over a public suggestion cache. */
      }
      return cached;
    } catch {
      if (saved) {
        cached = saved;
        return saved;
      }
      throw new Error(
        'The expanded food catalog is unavailable. Common foods and typing still work.',
      );
    } finally {
      clearTimeout(timeout);
      pending = null;
    }
  })();
  return pending;
}
