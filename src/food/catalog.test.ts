import { beforeEach, describe, expect, it, vi } from 'vitest';
import { combineFoodNames, searchFoodNames } from './catalog';

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});
const response = (names: unknown) =>
  new Response(JSON.stringify({ version: 1, names }), {
    headers: { 'Content-Type': 'application/json' },
  });

describe('large local food suggestions', () => {
  it('ranks exact/word prefixes, searches reordered words and accents, and preserves recent spelling', () => {
    const names = combineFoodNames(['Crème fraîche', 'Red lentil flour'], ['Carrots']);
    expect(searchFoodNames('car', names)[0]).toBe('Carrots');
    expect(searchFoodNames('creme fraiche', names)).toContain('Crème fraîche');
    expect(searchFoodNames('flour red', names)).toEqual(['Red lentil flour']);
    expect(searchFoodNames('carrots', names)).toEqual(['Carrots']);
    expect(searchFoodNames('', names, 2)).toHaveLength(2);
  });
  it('loads the deployed names once, shares concurrent reads and caches for offline reloads', async () => {
    const { loadFoodNames } = await import('./catalog');
    const fetcher = vi.fn().mockResolvedValue(response(['Furikake', 'Tahini']));
    expect(await Promise.all([loadFoodNames(fetcher), loadFoodNames(fetcher)])).toEqual([
      ['Furikake', 'Tahini'],
      ['Furikake', 'Tahini'],
    ]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toBe('/data/food-ingredients.json');
    vi.resetModules();
    const reload = await import('./catalog');
    const offline = vi.fn().mockRejectedValue(new TypeError('offline'));
    expect(await reload.loadFoodNames(offline)).toEqual(['Furikake', 'Tahini']);
    expect(offline).not.toHaveBeenCalled();
  });
  it('rejects malformed or excessive data without caching it, allowing a later retry', async () => {
    const { loadFoodNames } = await import('./catalog');
    await expect(
      loadFoodNames(vi.fn().mockResolvedValue(response(['Milk', null]))),
    ).rejects.toThrow('expanded food catalog');
    expect(await loadFoodNames(vi.fn().mockResolvedValue(response(['Milk'])))).toEqual(['Milk']);
  });
  it('retains an expired public cache if the network is unavailable', async () => {
    localStorage.setItem('mise.food-catalog.v1', JSON.stringify({ savedAt: 1, names: ['Tahini'] }));
    const { loadFoodNames } = await import('./catalog');
    expect(await loadFoodNames(vi.fn().mockRejectedValue(new TypeError('offline')))).toEqual([
      'Tahini',
    ]);
  });
});
