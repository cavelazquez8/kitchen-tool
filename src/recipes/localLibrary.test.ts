import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearLocalRecipeCache,
  loadLocalRecipes,
  recipeFacets,
  searchLocalRecipes,
  uniqueRecipes,
} from './localLibrary';
import { isRecipe, type Recipe } from './types';

function recipe(id = 'wikibooks:1', title = 'Chicken and rice'): Recipe {
  return {
    id,
    title,
    servings: 2,
    category: 'Main dishes',
    cuisine: 'American',
    ingredients: [
      { name: 'Chicken breast', quantity: 400, unit: 'g' },
      { name: 'Rice', quantity: 1, unit: 'cup' },
    ],
    steps: ['Cook the rice.', 'Cook the chicken thoroughly.'],
    source: {
      type: 'wikibooks',
      name: 'Wikibooks Cookbook',
      url: 'https://en.wikibooks.org/w/index.php?oldid=42',
      attribution: 'Wikibooks contributors · CC BY-SA 4.0; adapted for Mise.',
      licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    },
  };
}

function response(recipes: unknown[] = [recipe()]) {
  return new Response(JSON.stringify({ version: 1, recipes }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  clearLocalRecipeCache();
  vi.restoreAllMocks();
});

describe('deployed recipe collection', () => {
  it('repairs demonstrable old measure artifacts only in the built-in collection', async () => {
    const collection = {
      ...recipe(),
      ingredients: [
        {
          name: 'sticks (375 g / 13 oz) butter, melted',
          quantity: 3,
          unit: 'each',
          original: '3 sticks (375 g / 13 oz) butter, melted',
        },
        { name: 'ea. (50 g) egg', quantity: 1, unit: 'each', original: '1 ea. (50 g) egg' },
        { name: 'ea. (50 g) eggs', quantity: null, unit: 'each', original: '2 ea. (50 g) eggs' },
      ],
    };
    const loaded = await loadLocalRecipes(
      vi.fn<typeof fetch>().mockResolvedValue(response([collection])),
    );
    expect(loaded[0].ingredients).toMatchObject([
      { name: 'butter, melted', quantity: 3, unit: 'stick' },
      { name: 'egg', quantity: 1, unit: 'each' },
      { name: 'eggs', quantity: null, unit: 'each' },
    ]);
    expect(loaded[0].ingredients[0].original).toBe(collection.ingredients[0].original);
    expect(collection.ingredients[0].name).toContain('sticks (');
    const personal = {
      ...collection,
      ingredients: [
        {
          name: 'Corrected butter',
          quantity: 125,
          unit: 'g',
          original: collection.ingredients[0].original,
        },
      ],
    };
    expect(uniqueRecipes([personal, loaded[0]])[0]).toBe(personal);
    expect(uniqueRecipes([personal, loaded[0]])[0].ingredients[0]).toEqual(personal.ingredients[0]);
  });
  it('loads lazily from Mise once, preserving source attribution and full cooking instructions', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
    expect(fetcher).not.toHaveBeenCalled();
    const loaded = await loadLocalRecipes(fetcher);
    expect(loaded).toEqual([recipe()]);
    expect(await loadLocalRecipes(fetcher)).toBe(loaded);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      '/data/wikibooks-recipes.json',
      expect.objectContaining({ credentials: 'same-origin', redirect: 'error' }),
    );
    expect(loaded[0].source.attribution).toContain('Wikibooks contributors');
  });

  it('shares one in-flight load without duplicate downloads', async () => {
    let complete: (value: Response) => void = () => {};
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    const first = loadLocalRecipes(fetcher);
    const second = loadLocalRecipes(fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    complete(response());
    expect(await first).toBe(await second);
  });

  it('allows retry after an unavailable collection instead of retaining a rejected promise', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(response());
    await expect(loadLocalRecipes(fetcher)).rejects.toThrow('saved recipes are still available');
    expect(await loadLocalRecipes(fetcher)).toEqual([recipe()]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects corrupted recipes and unknown payload versions without poisoning a later load', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([{ ...recipe(), steps: [] }]))
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: 2, recipes: [recipe()] })))
      .mockResolvedValueOnce(response());
    await expect(loadLocalRecipes(fetcher)).rejects.toThrow('could not be loaded');
    await expect(loadLocalRecipes(fetcher)).rejects.toThrow('could not be loaded');
    expect(await loadLocalRecipes(fetcher)).toHaveLength(1);
  });

  it('bounds response bytes and collection size before accepting data', async () => {
    const tooLarge = new Response('{}', {
      headers: { 'Content-Length': String(20 * 1024 * 1024 + 1) },
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tooLarge)
      .mockResolvedValueOnce(response(Array.from({ length: 10_001 }, () => recipe())));
    await expect(loadLocalRecipes(fetcher)).rejects.toThrow('could not be loaded');
    await expect(loadLocalRecipes(fetcher)).rejects.toThrow('could not be loaded');
  });

  it('retains recipes beyond the previous twelve-result limit and removes duplicate IDs', async () => {
    const recipes = Array.from({ length: 50 }, (_, index) => recipe(`wikibooks:${index}`));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response([...recipes, recipes[0]]));
    expect(await loadLocalRecipes(fetcher)).toEqual(recipes);
  });

  it('rejects unsafe attribution links and malformed license fields', () => {
    expect(isRecipe(recipe())).toBe(true);
    expect(
      isRecipe({ ...recipe(), source: { ...recipe().source, licenseUrl: 'javascript:alert(1)' } }),
    ).toBe(false);
    expect(isRecipe({ ...recipe(), source: { ...recipe().source, attribution: 42 } })).toBe(false);
    expect(isRecipe({ ...recipe(), source: { ...recipe().source, license: '' } })).toBe(false);
  });
});

describe('local browsing', () => {
  it('matches query words across titles and ingredients, with normalized accents and aliases', () => {
    const recipes = [
      recipe(),
      {
        ...recipe('wikibooks:2', 'Crème tomato soup'),
        ingredients: [{ name: 'Tomato', quantity: 2, unit: 'each' }],
      },
    ];
    expect(searchLocalRecipes(recipes, '  chicken RICE ')).toEqual([recipes[0]]);
    expect(searchLocalRecipes(recipes, 'creme tomatoes')).toEqual([recipes[1]]);
    expect(searchLocalRecipes(recipes, 'rice pasta')).toEqual([]);
    expect(searchLocalRecipes(recipes, '')).toEqual(recipes);
  });

  it('combines cuisine and category choices with ingredient search', () => {
    const recipes = [
      recipe(),
      { ...recipe('wikibooks:2'), category: 'Soups', cuisine: 'Italian' },
      { ...recipe('wikibooks:3'), category: 'Main dishes', cuisine: 'Italian' },
    ];
    expect(
      searchLocalRecipes(recipes, 'chicken', { category: 'Main dishes', cuisine: 'Italian' }),
    ).toEqual([recipes[2]]);
    expect(searchLocalRecipes(recipes, '', { category: 'Desserts' })).toEqual([]);
  });

  it('exposes unique sorted category and cuisine choices, omitting missing values', () => {
    const recipes = [
      recipe(),
      { ...recipe('wikibooks:2'), category: 'Soups', cuisine: 'Italian' },
      { ...recipe('wikibooks:3'), category: undefined, cuisine: undefined },
    ];
    expect(recipeFacets(recipes)).toEqual({
      categories: ['Main dishes', 'Soups'],
      cuisines: ['American', 'Italian'],
    });
  });

  it('keeps personal edits when the caller gives them priority, without changing its arrays', () => {
    const published = recipe();
    const personal = { ...published, title: 'My chicken and rice' };
    const input = [personal, published, recipe('wikibooks:2', 'Soup')];
    expect(uniqueRecipes(input)).toEqual([personal, input[2]]);
    expect(input).toHaveLength(3);
  });
});
