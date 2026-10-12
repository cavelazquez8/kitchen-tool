import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InventoryState } from '../domain/types';
import type { Recipe } from './types';
import {
  browseRecipes,
  dedupeRecipes,
  recipeCollectionLabel,
  recipeSourceName,
  requestScopeKey,
  selectRecipeCollection,
} from './browse';

function recipe(id: string, extra: Partial<Recipe> = {}): Recipe {
  return {
    id,
    title: id,
    servings: 2,
    category: 'Main dishes',
    cuisine: 'American',
    ingredients: [{ name: 'Chicken breast', quantity: 400, unit: 'g' }],
    steps: ['Cook thoroughly.'],
    source: { type: 'wikibooks' },
    ...extra,
  };
}

function kitchen(): InventoryState {
  return {
    products: [
      {
        id: 'chicken',
        name: 'Example Farms Fresh Chicken Breast Fillets',
        ingredientName: 'Chicken breast',
        isStaple: false,
      },
      { id: 'zucchini', name: 'Zucchini', isStaple: false },
    ],
    batches: [
      {
        id: 'chicken:1',
        productId: 'chicken',
        quantity: 0.5,
        unit: 'kg',
        location: 'freezer',
        purchasedOn: '2026-10-01',
        expiresOn: null,
      },
      {
        id: 'zucchini:1',
        productId: 'zucchini',
        quantity: 250,
        unit: 'g',
        location: 'fridge',
        purchasedOn: '2026-10-10',
        expiresOn: '2026-10-13',
      },
    ],
    tools: [],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-12T12:00:00'));
});

afterEach(() => vi.useRealTimers());

describe('shared recipe browsing', () => {
  it('combines query, category, cuisine, and ready filters across every recipe source', () => {
    const recipes = [
      recipe('wikibooks:ready', { title: 'Chicken dinner' }),
      recipe('recipeapi:ready', {
        title: 'Chicken soup',
        category: 'Soups',
        source: { type: 'imported', name: 'RecipeAPI.io' },
      }),
      recipe('spoonacular:ready', {
        title: 'Chicken dinner',
        cuisine: 'Italian',
        source: { type: 'imported', name: 'Spoonacular' },
      }),
      recipe('themealdb:short', {
        title: 'Chicken dinner',
        ingredients: [{ name: 'Chicken breast', quantity: 600, unit: 'g' }],
        source: { type: 'themealdb' },
      }),
    ];
    expect(browseRecipes(recipes, kitchen(), { query: 'Chicken', filter: 'ready' })).toHaveLength(
      3,
    );
    expect(
      browseRecipes(recipes, kitchen(), {
        query: 'Chicken',
        filter: 'ready',
        category: 'Main dishes',
        cuisine: 'American',
      }).map((match) => match.recipe.id),
    ).toEqual(['wikibooks:ready']);
    expect(
      browseRecipes(recipes, kitchen(), {
        query: 'Chicken',
        filter: 'ready',
        cuisine: 'Italian',
      }).map((match) => match.recipe.id),
    ).toEqual(['spoonacular:ready']);
    expect(browseRecipes(recipes, kitchen(), { query: 'Dessert' })).toHaveLength(0);
  });

  it('counts only recipes matching saved and availability choices', () => {
    const ready = recipe('recipeapi:saved', { source: { type: 'imported', name: 'RecipeAPI.io' } });
    const close = recipe('themealdb:close', {
      source: { type: 'themealdb' },
      ingredients: [
        ...ready.ingredients,
        { name: 'Rice', quantity: 100, unit: 'g' },
        { name: 'Tomato', quantity: 1, unit: 'each' },
      ],
    });
    const far = recipe('wikibooks:far', {
      ingredients: [...close.ingredients, { name: 'Cheese', quantity: 50, unit: 'g' }],
    });
    const recipes = [ready, close, far];
    const inventory = { ...kitchen(), recipes: [ready, far] };
    expect(browseRecipes(recipes, inventory, { filter: 'all' })).toHaveLength(3);
    expect(browseRecipes(recipes, inventory, { filter: 'ready' })).toHaveLength(1);
    expect(browseRecipes(recipes, inventory, { filter: 'close' })).toHaveLength(2);
    expect(browseRecipes(recipes, inventory, { filter: 'saved' })).toHaveLength(2);
    expect(
      browseRecipes(recipes, inventory, { filter: 'saved', savedIds: [close.id] })[0].recipe,
    ).toBe(close);
    expect(browseRecipes(recipes, inventory, { filter: 'saved', savedIds: [] })).toHaveLength(0);
  });

  it('uses confirmed branded identities, ingredient aliases, and compatible recorded quantities', () => {
    const recipes = [
      recipe('recipeapi:vegetables', {
        source: { type: 'imported', name: 'RecipeAPI.io' },
        ingredients: [
          { name: 'Chicken breasts', quantity: 400, unit: 'g' },
          { name: 'Courgettes', quantity: 0.2, unit: 'kg' },
        ],
      }),
      recipe('recipeapi:not-enough', {
        ingredients: [{ name: 'Chicken breasts', quantity: 600, unit: 'g' }],
      }),
    ];
    const ready = browseRecipes(recipes, kitchen(), { filter: 'ready', query: 'Zucchini' });
    expect(ready).toHaveLength(1);
    expect(ready[0].matchedCount).toBe(2);
    expect(ready[0].ingredients.map((ingredient) => ingredient.available)).toEqual([500, 0.25]);
    expect(browseRecipes(recipes, kitchen(), { filter: 'close' })).toHaveLength(2);
  });

  it('does not include unknown package amounts among ready-to-cook results', () => {
    const inventory = kitchen();
    inventory.batches[0] = { ...inventory.batches[0], quantity: 1, unit: 'package' };
    const matches = browseRecipes([recipe('packaged-chicken')], inventory);
    expect(matches[0].status).toBe('check');
    expect(
      browseRecipes([recipe('packaged-chicken')], inventory, { filter: 'ready' }),
    ).toHaveLength(0);
  });

  it('keeps expiration priority meaningful in alphabetical browse order', () => {
    const chicken = recipe('chicken', { title: 'Alpha chicken' });
    const vegetables = recipe('vegetables', {
      title: 'Zucchini supper',
      ingredients: [{ name: 'Courgette', quantity: 200, unit: 'g' }],
    });
    const recipes = [vegetables, chicken];
    expect(
      browseRecipes(recipes, kitchen(), { order: 'browse' }).map((match) => match.recipe.id),
    ).toEqual(['chicken', 'vegetables']);
    expect(
      browseRecipes(recipes, kitchen(), {
        order: 'browse',
        prioritizeExpiration: true,
      }).map((match) => match.recipe.id),
    ).toEqual(['vegetables', 'chicken']);
    expect(recipes).toEqual([vegetables, chicken]);
  });

  it('keeps saved edits and attribution when combining sourced recipes', () => {
    const original = recipe('wikibooks:1', {
      source: { type: 'wikibooks', attribution: 'Wikibooks contributors', license: 'CC BY-SA 4.0' },
    });
    const other = recipe('themealdb:2');
    const edited = { ...original, title: 'My corrected dinner' };
    const combined = dedupeRecipes([original, other], [original], [edited]);
    expect(combined).toEqual([edited, other]);
    expect(combined[0]).toBe(edited);
    expect(original.title).toBe('wikibooks:1');
    expect(combined[0].source.attribution).toBe('Wikibooks contributors');
  });
});

describe('personal recipe collections', () => {
  it('includes every saved origin in Saved recipes while keeping unsaved results out', () => {
    const recipes = [
      recipe('wikibooks:saved'),
      recipe('recipeapi:saved', { source: { type: 'imported', name: 'RecipeAPI.io' } }),
      recipe('user:import', { source: { type: 'imported', name: 'My favorite recipe website' } }),
      recipe('user:manual', { source: { type: 'manual' } }),
      recipe('user:ai', { source: { type: 'ai', name: 'Gemini' } }),
      recipe('themealdb:unsaved', { source: { type: 'themealdb' } }),
    ];
    const savedIds = recipes.slice(0, 5).map((item) => item.id);
    expect(selectRecipeCollection(recipes, 'all', savedIds)).toHaveLength(6);
    expect(selectRecipeCollection(recipes, 'saved', savedIds)).toEqual(recipes.slice(0, 5));
    expect(selectRecipeCollection(recipes, 'saved', [])).toEqual([]);
  });

  it('keeps personal imports distinct from provider results without modifying their source', () => {
    const imported = recipe('user:website', {
      source: {
        type: 'imported',
        name: 'Cooking website',
        url: 'https://example.com/chicken-dinner',
        attribution: 'Original author',
      },
    });
    const recipes = [
      imported,
      recipe('user:unsaved-import', { source: { type: 'imported' } }),
      recipe('recipeapi:123', { source: { type: 'imported', name: 'Renamed API source' } }),
      recipe('spoonacular:456', { source: { type: 'imported' } }),
      recipe('restored:recipeapi', { source: { type: 'imported', name: 'RecipeAPI.io' } }),
      recipe('restored:spoonacular', { source: { type: 'imported', name: 'Spoonacular' } }),
    ];
    const savedIds = recipes
      .filter((item) => item.id !== 'user:unsaved-import')
      .map((item) => item.id);
    const collection = selectRecipeCollection(recipes, 'imported', savedIds);
    expect(collection).toEqual([imported]);
    expect(collection[0]).toBe(imported);
    expect(collection[0].source).toEqual({
      type: 'imported',
      name: 'Cooking website',
      url: 'https://example.com/chicken-dinner',
      attribution: 'Original author',
    });
    expect(recipes).toHaveLength(6);
  });

  it('combines Imported recipes with Ready to cook, query, and cuisine independently', () => {
    const ready = recipe('user:ready-import', {
      title: 'Chicken dinner',
      source: { type: 'imported', name: 'Cooking website' },
    });
    const short = recipe('user:short-import', {
      title: 'Chicken dinner for a crowd',
      source: { type: 'imported' },
      ingredients: [{ name: 'Chicken breast', quantity: 800, unit: 'g' }],
    });
    const manual = recipe('user:manual', { source: { type: 'manual' } });
    const provider = recipe('recipeapi:ready', {
      title: 'Chicken dinner',
      source: { type: 'imported', name: 'RecipeAPI.io' },
    });
    const recipes = [ready, short, manual, provider];
    const inventory = { ...kitchen(), recipes };
    expect(browseRecipes(recipes, inventory, { collection: 'imported' })).toHaveLength(2);
    expect(
      browseRecipes(recipes, inventory, {
        collection: 'imported',
        filter: 'ready',
        query: 'Chicken',
        cuisine: 'American',
      }).map((match) => match.recipe.id),
    ).toEqual([ready.id]);
    expect(
      browseRecipes(recipes, inventory, { collection: 'saved', filter: 'ready' }),
    ).toHaveLength(3);
    expect(
      browseRecipes(recipes, inventory, { collection: 'imported', filter: 'ready', savedIds: [] }),
    ).toEqual([]);
  });

  it('uses exact saved source types for Your own recipes and AI-created recipes', () => {
    const recipes = [
      recipe('user:manual', { source: { type: 'manual' } }),
      recipe('user:ai', { source: { type: 'ai', name: 'Gemini' } }),
      recipe('user:import', { source: { type: 'imported', name: 'Gemini' } }),
      recipe('generated:unsaved', { source: { type: 'ai', name: 'Gemini' } }),
    ];
    const savedIds = recipes.slice(0, 3).map((item) => item.id);
    expect(selectRecipeCollection(recipes, 'manual', savedIds)).toEqual([recipes[0]]);
    expect(selectRecipeCollection(recipes, 'ai', savedIds)).toEqual([recipes[1]]);
    expect(selectRecipeCollection(recipes, 'manual', [])).toEqual([]);
    expect(selectRecipeCollection(recipes, 'ai', [])).toEqual([]);
  });

  it('gives each collection its user-facing label', () => {
    expect(recipeCollectionLabel('all')).toBe('All recipes');
    expect(recipeCollectionLabel('saved')).toBe('Saved recipes');
    expect(recipeCollectionLabel('imported')).toBe('Imported recipes');
    expect(recipeCollectionLabel('manual')).toBe('Your own recipes');
    expect(recipeCollectionLabel('ai')).toBe('AI-created recipes');
  });
});

describe('recipe search request identity', () => {
  it('recognizes normalized text and ingredient set order without presentation settings', () => {
    expect(requestScopeKey('recipeapi', '  Chicken   Soup ', ['Rice', ' tomato ', 'rice'])).toBe(
      requestScopeKey('recipeapi', 'chicken soup', ['Tomato', 'Rice']),
    );
    expect(requestScopeKey('spoonacular', '', ['Chicken breast', 'Rice'])).toBe(
      requestScopeKey('spoonacular', '', ['rice', 'chicken  breast']),
    );
  });

  it('changes whenever the source, query, or ingredient set changes', () => {
    const key = requestScopeKey('recipeapi', '', ['Rice']);
    expect(requestScopeKey('spoonacular', '', ['Rice'])).not.toBe(key);
    expect(requestScopeKey('recipeapi', 'Rice', ['Rice'])).not.toBe(key);
    expect(requestScopeKey('recipeapi', '', ['Rice', 'Tomato'])).not.toBe(key);
    expect(requestScopeKey('recipeapi', '', [])).not.toBe(key);
    expect(requestScopeKey('recipeapi', 'a,b', ['c'])).not.toBe(
      requestScopeKey('recipeapi', 'a', ['b,c']),
    );
  });

  it('names the selected recipe source directly', () => {
    expect(recipeSourceName('library')).toBe('Your cookbook');
    expect(recipeSourceName('themealdb')).toBe('TheMealDB');
    expect(recipeSourceName('recipeapi')).toBe('RecipeAPI.io');
    expect(recipeSourceName('spoonacular')).toBe('Spoonacular');
  });
});
