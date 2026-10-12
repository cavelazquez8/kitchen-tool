export interface PackagedFood {
  code: string;
  name: string;
  brand: string;
}
// The v2 API explicitly does not support full-text queries; use documented v1 search.
const ENDPOINT = 'https://world.openfoodfacts.org/cgi/search.pl';
const cache = new Map<string, { expires: number; products: PackagedFood[] }>();
let calls: number[] = [];
let blockedUntil = 0;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function field(value: unknown, max = 120): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
/** Explicit button action only: OFF prohibits product search-as-you-type. */
export async function findPackagedFoods(
  query: string,
  fetcher: typeof fetch = fetch,
): Promise<PackagedFood[]> {
  const term = query.trim().slice(0, 100);
  if (term.length < 3)
    throw new Error('Enter at least three characters to find a packaged product.');
  const key = term.toLocaleLowerCase('en');
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.products;
  calls = calls.filter((time) => Date.now() - time < 60_000);
  if (
    Date.now() < blockedUntil ||
    calls.length >= 8 ||
    (calls.length && Date.now() - calls.at(-1)! < 7500)
  )
    throw new Error('Please wait a moment before searching for another product.');
  calls.push(Date.now());
  const url = new URL(ENDPOINT);
  url.searchParams.set('search_terms', term);
  url.searchParams.set('search_simple', '1');
  url.searchParams.set('action', 'process');
  url.searchParams.set('json', '1');
  url.searchParams.set('fields', 'code,product_name,product_name_en,brands');
  url.searchParams.set('page_size', '12');
  url.searchParams.set('lc', 'en');
  // Browsers cannot reliably override User-Agent; identify the app as query metadata.
  url.searchParams.set('app_name', 'Mise');
  url.searchParams.set('app_version', '1.0');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetcher(url.href, {
      signal: controller.signal,
      credentials: 'omit',
      redirect: 'error',
    });
    if (response.status === 429) {
      blockedUntil = Date.now() + 60_000;
      throw new Error(
        'Open Food Facts is busy. Try again in a minute, or enter the product yourself.',
      );
    }
    if (!response.ok || Number(response.headers.get('Content-Length')) > 128_000 || !response.body)
      throw new Error('Product search is unavailable. You can still enter any item yourself.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let raw = '',
      bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 128_000) {
          await reader.cancel();
          throw new Error('Product search returned too much data.');
        }
        raw += decoder.decode(chunk.value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }
    const payload: unknown = JSON.parse(raw + decoder.decode());
    if (!record(payload) || !Array.isArray(payload.products))
      throw new Error(
        'Product search returned an unexpected response. You can still enter the item yourself.',
      );
    const products = payload.products.slice(0, 12).flatMap((product): PackagedFood[] => {
      if (!record(product)) return [];
      const name = field(product.product_name_en) || field(product.product_name);
      const code = field(product.code, 14);
      if (!name || !/^\d{8,14}$/.test(code)) return [];
      return [{ code, name, brand: field(product.brands) }];
    });
    if (cache.size >= 30) cache.delete(cache.keys().next().value!);
    cache.set(key, { expires: Date.now() + 30 * 60_000, products });
    return products;
  } catch (error) {
    if (
      error instanceof TypeError ||
      (error instanceof DOMException && error.name === 'AbortError')
    )
      throw new Error('Product search is unavailable. You can still enter any item yourself.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
