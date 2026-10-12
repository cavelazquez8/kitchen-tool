import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => vi.resetModules());
function response(products: unknown) {
  return new Response(JSON.stringify({ products }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
describe('explicit packaged-product lookup', () => {
  it('uses only the explicit query, bounds fields, validates results and reuses cached searches', async () => {
    const { findPackagedFoods } = await import('./products');
    const fetcher = vi.fn().mockResolvedValue(
      response([
        {
          code: '0123456789012',
          product_name: 'Spaghetti',
          brands: 'Pasta Brand',
          quantity: '500 g',
        },
        { code: 'abc', product_name: 'Invalid' },
        { code: '0123456789013', product_name: '' },
      ]),
    );
    expect(await findPackagedFoods('Spaghetti', fetcher)).toEqual([
      { code: '0123456789012', name: 'Spaghetti', brand: 'Pasta Brand' },
    ]);
    const url = new URL(fetcher.mock.calls[0][0]);
    expect(url.searchParams.get('search_terms')).toBe('Spaghetti');
    expect(url.searchParams.get('page_size')).toBe('12');
    expect(url.searchParams.get('fields')).not.toContain('quantity');
    await findPackagedFoods('spaghetti', fetcher);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('does not send short queries or rapid distinct requests', async () => {
    const { findPackagedFoods } = await import('./products');
    const fetcher = vi.fn().mockResolvedValue(response([]));
    await expect(findPackagedFoods('ab', fetcher)).rejects.toThrow('three characters');
    expect(fetcher).not.toHaveBeenCalled();
    await findPackagedFoods('Apples', fetcher);
    await expect(findPackagedFoods('Bananas', fetcher)).rejects.toThrow('wait a moment');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('backs off after rate limiting and keeps manual entry available', async () => {
    const { findPackagedFoods } = await import('./products');
    const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
    await expect(findPackagedFoods('Spaghetti', fetcher)).rejects.toThrow(
      'enter the product yourself',
    );
    await expect(findPackagedFoods('Pasta', fetcher)).rejects.toThrow('wait a moment');
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
