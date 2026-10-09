export interface ProductSuggestion {
  barcode: string;
  name: string;
  brand?: string;
  packageSize?: string;
  imageUrl?: string;
  source: 'open-food-facts';
}

export type LookupResult =
  | { status: 'found'; product: ProductSuggestion }
  | { status: 'not-found' }
  | { status: 'invalid' }
  | {
      status: 'unavailable';
      reason: 'rate-limit' | 'network' | 'cancelled';
      retryAfterMs?: number;
    };

const CACHE_KEY = 'kitchen.product-lookup.v1';
const BUDGET_KEY = 'kitchen.product-lookup-budget.v1';
const CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const WINDOW_MS = 60_000;
const READS_PER_WINDOW = 15;
const REQUEST_TIMEOUT_MS = 8_000;
const cache = new Map<string, { expiresAt: number; result: LookupResult }>();
let cacheLoaded = false;
let requestTimes: number[] = [];
let blockedUntil = 0;

function validCheckDigit(code: string): boolean {
  let sum = 0;
  for (let index = code.length - 2, position = 0; index >= 0; index--, position++) {
    sum += Number(code[index]) * (position % 2 === 0 ? 3 : 1);
  }
  return (sum + Number(code.at(-1))) % 10 === 0;
}

function expandUpcE(code: string): string | null {
  if (!/^[01]\d{7}$/.test(code)) return null;
  const [numberSystem, a, b, c, d, e, last, check] = code.split('');
  let expanded: string;
  if (Number(last) <= 2) {
    expanded = `${numberSystem}${a}${b}${last}0000${c}${d}${e}${check}`;
  } else if (last === '3') {
    expanded = `${numberSystem}${a}${b}${c}00000${d}${e}${check}`;
  } else if (last === '4') {
    expanded = `${numberSystem}${a}${b}${c}${d}00000${e}${check}`;
  } else {
    expanded = `${numberSystem}${a}${b}${c}${d}${e}0000${last}${check}`;
  }
  return validCheckDigit(expanded) ? expanded : null;
}

/** Validate UPC/EAN and normalize equivalent leading-zero variants to one key. */
export function normalizeBarcode(input: string, format?: 'UPC_E'): string | null {
  let code = input.replace(/[\s-]/g, '');
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(code)) return null;
  if (/^0+$/.test(code)) return null;
  if (format === 'UPC_E') {
    const expanded = expandUpcE(code);
    if (!expanded) return null;
    code = expanded;
  } else if (!validCheckDigit(code)) {
    // A typed eight-digit code may be UPC-E rather than EAN-8.
    const expanded = code.length === 8 ? expandUpcE(code) : null;
    if (!expanded) return null;
    code = expanded;
  }
  const significant = code.replace(/^0+/, '') || '0';
  if (significant.length <= 8) return significant.padStart(8, '0');
  if (significant.length <= 13) return significant.padStart(13, '0');
  return significant;
}

function readStorage(key: string): unknown {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as unknown) : null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Lookup remains available when the browser blocks local storage.
  }
}

function loadCache(): void {
  if (cacheLoaded) return;
  cacheLoaded = true;
  const stored = readStorage(CACHE_KEY);
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return;
  for (const [code, possible] of Object.entries(stored).slice(-100)) {
    if (normalizeBarcode(code) !== code || !possible || typeof possible !== 'object') continue;
    const value = possible as { expiresAt?: unknown; result?: unknown };
    if (
      typeof value.expiresAt !== 'number' ||
      !Number.isFinite(value.expiresAt) ||
      value.expiresAt <= Date.now()
    )
      continue;
    if (!value.result || typeof value.result !== 'object') continue;
    const result = value.result as { status?: unknown; product?: unknown };
    if (result.status === 'not-found') {
      cache.set(code, { expiresAt: value.expiresAt, result: { status: 'not-found' } });
    } else if (result.status === 'found' && result.product && typeof result.product === 'object') {
      const product = result.product as Record<string, unknown>;
      const name = textField(product.name);
      if (product.barcode !== code || !name) continue;
      const brand = textField(product.brand);
      const packageSize = textField(product.packageSize);
      const imageUrl = imageField(product.imageUrl);
      cache.set(code, {
        expiresAt: value.expiresAt,
        result: {
          status: 'found',
          product: {
            barcode: code,
            name,
            source: 'open-food-facts',
            ...(brand ? { brand } : {}),
            ...(packageSize ? { packageSize } : {}),
            ...(imageUrl ? { imageUrl } : {}),
          },
        },
      });
    }
  }
}

function cacheResult(code: string, result: LookupResult): LookupResult {
  loadCache();
  cache.set(code, { expiresAt: Date.now() + CACHE_TTL_MS, result });
  const retained = [...cache.entries()]
    .filter(([, entry]) => entry.expiresAt > Date.now())
    .slice(-100);
  writeStorage(CACHE_KEY, Object.fromEntries(retained));
  return result;
}

function cachedResult(code: string): LookupResult | undefined {
  loadCache();
  const entry = cache.get(code);
  if (entry && entry.expiresAt > Date.now()) {
    return entry.result;
  }
  return undefined;
}

function reserveRead(): number | null {
  const now = Date.now();
  const stored = readStorage(BUDGET_KEY);
  if (stored && typeof stored === 'object') {
    const budget = stored as { times?: unknown; blockedUntil?: unknown };
    if (Array.isArray(budget.times)) {
      requestTimes = budget.times.filter(
        (time): time is number => typeof time === 'number' && Number.isFinite(time),
      );
    }
    if (typeof budget.blockedUntil === 'number' && Number.isFinite(budget.blockedUntil))
      blockedUntil = budget.blockedUntil;
  }
  requestTimes = requestTimes.filter((time) => time > now - WINDOW_MS && time <= now);
  if (blockedUntil > now) return blockedUntil - now;
  if (requestTimes.length >= READS_PER_WINDOW) return requestTimes[0]! + WINDOW_MS - now;
  requestTimes.push(now);
  writeStorage(BUDGET_KEY, { times: requestTimes, blockedUntil });
  return null;
}

function textField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 250) : undefined;
}

function imageField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.endsWith('.openfoodfacts.org')
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Call after checking user-owned barcode mappings. Results are suggestions, not
 * package dates. Reserve at most 15 reads per rolling minute, including failures.
 * https://openfoodfacts.github.io/openfoodfacts-server/api/
 */
export async function lookupProduct(input: string, signal?: AbortSignal): Promise<LookupResult> {
  const code = normalizeBarcode(input);
  if (!code) return { status: 'invalid' };
  if (signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
  const cached = cachedResult(code);
  if (cached) return cached;
  const retryAfterMs = reserveRead();
  if (retryAfterMs !== null) return { status: 'unavailable', reason: 'rate-limit', retryAfterMs };

  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(cancel, REQUEST_TIMEOUT_MS);
  const url = new URL(`https://world.openfoodfacts.org/api/v3.6/product/${code}`);
  url.searchParams.set(
    'fields',
    'code,product_name,product_name_en,brands,quantity,image_front_small_url',
  );
  url.searchParams.set('lc', 'en');
  // User-Agent cannot reliably be overridden in browsers. Include the app name
  // as query metadata; no camera image or user inventory is sent to this service.
  url.searchParams.set('app_name', 'Kitchen Wrapper');
  url.searchParams.set('app_version', '1.0');

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (response.status === 404) return cacheResult(code, { status: 'not-found' });
    if (response.status === 429) {
      const retryHeader = response.headers.get('Retry-After');
      const retrySeconds = Number(retryHeader);
      const retryDate = retryHeader ? Date.parse(retryHeader) : Number.NaN;
      const delay =
        retryHeader && Number.isFinite(retrySeconds)
          ? retrySeconds * 1_000
          : Number.isFinite(retryDate)
            ? retryDate - Date.now()
            : WINDOW_MS;
      blockedUntil = Date.now() + Math.max(WINDOW_MS, delay);
      writeStorage(BUDGET_KEY, { times: requestTimes, blockedUntil });
      return {
        status: 'unavailable',
        reason: 'rate-limit',
        retryAfterMs: blockedUntil - Date.now(),
      };
    }
    if (!response.ok) return { status: 'unavailable', reason: 'network' };
    const data: unknown = await response.json();
    if (!data || typeof data !== 'object') return { status: 'unavailable', reason: 'network' };
    const productValue = (data as { product?: unknown }).product;
    if (!productValue || typeof productValue !== 'object')
      return cacheResult(code, { status: 'not-found' });
    const product = productValue as Record<string, unknown>;
    const name = textField(product.product_name_en) ?? textField(product.product_name);
    if (!name) return cacheResult(code, { status: 'not-found' });
    const brand = textField(product.brands);
    const packageSize = textField(product.quantity);
    const imageUrl = imageField(product.image_front_small_url);
    return cacheResult(code, {
      status: 'found',
      product: {
        barcode: code,
        name,
        ...(brand ? { brand } : {}),
        ...(packageSize ? { packageSize } : {}),
        ...(imageUrl ? { imageUrl } : {}),
        source: 'open-food-facts',
      },
    });
  } catch {
    return { status: 'unavailable', reason: signal?.aborted ? 'cancelled' : 'network' };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}
