import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeBarcode } from './lookup';

describe('barcode identity', () => {
  it('uses one identity for UPC-A and its zero-prefixed EAN-13', () => {
    expect(normalizeBarcode('034000470693')).toBe('0034000470693');
    expect(normalizeBarcode('0034000470693')).toBe('0034000470693');
    expect(normalizeBarcode('034000-470693')).toBe('0034000470693');
  });

  it('keeps EAN-8 identities and verifies check digits', () => {
    expect(normalizeBarcode('96385074')).toBe('96385074');
    expect(normalizeBarcode('96385075')).toBeNull();
    expect(normalizeBarcode('3017620422003')).toBe('3017620422003');
    expect(normalizeBarcode('3017620422004')).toBeNull();
    expect(normalizeBarcode('abc3017620422003')).toBeNull();
    expect(normalizeBarcode('')).toBeNull();
    expect(normalizeBarcode('00000000')).toBeNull();
  });

  it('expands a decoder-identified UPC-E into its UPC-A identity', () => {
    expect(normalizeBarcode('04252614', 'UPC_E')).toBe(normalizeBarcode('042100005264'));
  });
});

function testCode(index: number): string {
  const body = `200000${String(index).padStart(6, '0')}`;
  let sum = 0;
  for (let i = body.length - 1, n = 0; i >= 0; i--, n++)
    sum += Number(body[i]) * (n % 2 === 0 ? 3 : 1);
  return `${body}${(10 - (sum % 10)) % 10}`;
}

describe('product suggestions', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('requests identification fields, caches the result, and never supplies expiration', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'success',
          product: {
            product_name: 'Peanut butter',
            brands: 'Example',
            quantity: '16 oz',
            expiration_date: '2030-01-01',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { lookupProduct } = await import('./lookup');
    const result = await lookupProduct('034000470693');
    expect(result).toEqual({
      status: 'found',
      product: {
        barcode: '0034000470693',
        name: 'Peanut butter',
        brand: 'Example',
        packageSize: '16 oz',
        packageQuantity: { quantity: 16, unit: 'oz' },
        ingredientIdentity: { candidates: ['Peanut butter'], confidence: 'clear' },
        source: 'open-food-facts',
      },
    });
    expect((fetchMock.mock.calls[0]![0] as URL).searchParams.get('fields')).not.toContain(
      'expiration',
    );
    expect(await lookupProduct('0034000470693')).toEqual(result);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('leaves a missing product as a manual naming task', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    const { lookupProduct } = await import('./lookup');
    expect(await lookupProduct('3017620422003')).toEqual({ status: 'not-found' });
  });

  it('returns generic/category metadata for review without confirming an ingredient or multipack weight', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            product: {
              product_name: 'Example supper sauce',
              brands: 'Example',
              generic_name_en: 'Tomato sauce',
              categories_tags: ['en:pasta-sauces'],
              quantity: '6 x 100g',
            },
          }),
          { status: 200 },
        ),
      ),
    );
    const { lookupProduct } = await import('./lookup');
    const result = await lookupProduct('3017620422003');
    expect(result).toMatchObject({
      status: 'found',
      product: {
        name: 'Example supper sauce',
        genericName: 'Tomato sauce',
        ingredientIdentity: { confidence: 'review', candidates: ['Tomato sauce', 'Pasta sauce'] },
      },
    });
    if (result.status === 'found') {
      expect(result.product).not.toHaveProperty('ingredientName');
      expect(result.product.packageQuantity).toBeUndefined();
    }
  });

  it('preserves remembered suggestions across reloads when new products are looked up', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            status: 'success',
            product: { product_name: 'Example product' },
          }),
          { status: 200 },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    let lookup = (await import('./lookup')).lookupProduct;
    await lookup('3017620422003');
    vi.resetModules();
    lookup = (await import('./lookup')).lookupProduct;
    await lookup('034000470693');
    vi.resetModules();
    lookup = (await import('./lookup')).lookupProduct;
    expect(await lookup('3017620422003')).toMatchObject({ status: 'found' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honors provider throttling without more requests during the cooldown', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 429, headers: { 'Retry-After': '120' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { lookupProduct } = await import('./lookup');
    expect(await lookupProduct('3017620422003')).toMatchObject({
      status: 'unavailable',
      reason: 'rate-limit',
    });
    expect(await lookupProduct('034000470693')).toMatchObject({
      status: 'unavailable',
      reason: 'rate-limit',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reserves no more than fifteen product reads in one minute', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response(null, { status: 404 })));
    vi.stubGlobal('fetch', fetchMock);
    const { lookupProduct } = await import('./lookup');
    for (let i = 0; i < 15; i++)
      expect(await lookupProduct(testCode(i))).toEqual({ status: 'not-found' });
    expect(await lookupProduct(testCode(15))).toMatchObject({
      status: 'unavailable',
      reason: 'rate-limit',
    });
    expect(fetchMock).toHaveBeenCalledTimes(15);
  });

  it('times out stalled lookup instead of blocking grocery check-in indefinitely', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: URL, options: RequestInit) =>
          new Promise((_resolve, reject) => {
            options.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          }),
      ),
    );
    const { lookupProduct } = await import('./lookup');
    const result = lookupProduct('3017620422003');
    await vi.advanceTimersByTimeAsync(8_001);
    expect(await result).toEqual({ status: 'unavailable', reason: 'network' });
  });
});
