import { describe, expect, it } from 'vitest';
import bundledCollectionText from '../../public/data/wikibooks-recipes.json?raw';
import type { InventoryState } from '../domain/types';
import type { Recipe } from './types';
import { getStarterRecipes, recommendRecipes, STARTER_RECIPES } from './recommendations';

const empty: InventoryState = { products: [], batches: [], tools: [] };
const collection: { recipes: Recipe[] } = JSON.parse(bundledCollectionText);

function dish(id: string, title: string, ingredient = 'Chicken breast'): Recipe {
  return {
    id,
    title,
    servings: 2,
    ingredients: [{ name: ingredient, quantity: 250, unit: 'g' }],
    steps: ['Follow the source instructions.'],
    source: { type: 'imported', url: 'https://example.org/recipe', name: 'Source recipe' },
  };
}

describe('recipe-first local discovery', () => {
  it('curates existing attributed records with recorded yields without copying or rewriting them', () => {
    const result = getStarterRecipes(collection.recipes);
    expect(result).toHaveLength(24);
    expect(new Set(STARTER_RECIPES.map(({ id }) => id)).size).toBe(24);
    for (const recipe of result) {
      expect(recipe).toBe(collection.recipes.find((record) => record.id === recipe.id));
      expect(recipe.servings).toBeGreaterThan(0);
      expect(recipe.source.url).toContain('oldid=');
      expect(recipe.source.license).toBe('CC BY-SA 4.0');
      expect(recipe.source.attribution).toContain('Wikibooks contributors');
      expect(
        recipe.ingredients.every(
          (ingredient) => ingredient.optional || ingredient.quantity !== null,
        ),
      ).toBe(true);
    }
  });

  it('offers established dishes with an empty inventory and keeps ingredient gaps', () => {
    const result = recommendRecipes(collection.recipes, empty, { limit: 6 });
    expect(result.map((recipe) => recipe.title)).toEqual([
      'Skillet Lasagna',
      'Thai Grilled Chicken II',
      'Southwestern Black Beans and Rice',
      'Spanish Potato Omelette',
      'Chicken Parmigiana',
      'Spinach Mushroom Pesto Spaghetti',
    ]);
    expect(result[0].ingredients.some((ingredient) => ingredient.name.includes('beef'))).toBe(true);
  });

  it('retrieves a familiar dinner shortlist from the assistant’s natural starter prompt', () => {
    const result = recommendRecipes(collection.recipes, empty, {
      query: 'Help me choose a familiar dinner. Ask me a question if you need to.',
      limit: 12,
    });
    expect(result).toHaveLength(12);
    expect(result.every((recipe) => STARTER_RECIPES.some(({ id }) => id === recipe.id))).toBe(true);
    expect(result.some((recipe) => /Thanksgiving|Prime Rib/.test(recipe.title))).toBe(false);
  });

  it('searches actual titles, cuisine, curated dish labels, ingredients, and typed prefixes', () => {
    expect(
      recommendRecipes(getStarterRecipes(collection.recipes), empty, {
        query: 'I want a Thai chicken dinner',
        limit: 1,
      })[0].title,
    ).toBe('Thai Grilled Chicken II');
    expect(recommendRecipes(collection.recipes, empty, { query: 'chic', limit: 4 })).toHaveLength(
      4,
    );
    expect(
      recommendRecipes(getStarterRecipes(collection.recipes), empty, {
        query: 'oatmeal breakfast',
        limit: 1,
      })[0].title,
    ).toBe('Microwave Oat Porridge');
    expect(recommendRecipes(collection.recipes, empty, { query: 'unfindableingredient' })).toEqual(
      [],
    );
  });

  it('uses confirmed stock as a preference without hiding recipes that need groceries', () => {
    const recipes = [dish('apple', 'Apple dish', 'Apples'), dish('chicken', 'Chicken dish')];
    const inventory: InventoryState = {
      products: [
        {
          id: 'p',
          name: 'Branded chicken breast',
          ingredientName: 'Chicken breast',
          isStaple: false,
        },
      ],
      batches: [
        {
          id: 'b',
          productId: 'p',
          location: 'fridge',
          quantity: 300,
          unit: 'g',
          purchasedOn: '2026-10-01',
          expiresOn: null,
        },
      ],
      tools: [],
    };
    expect(recommendRecipes(recipes, inventory).map(({ id }) => id)).toEqual(['chicken', 'apple']);
    expect(recommendRecipes(recipes, inventory, { query: 'apple' })).toEqual([recipes[0]]);
    inventory.batches[0].quantity = 0;
    expect(recommendRecipes(recipes, inventory).map(({ id }) => id)).toEqual(['apple', 'chicken']);
  });

  it('does not send transient Spoonacular content or AI drafts into a sourced shortlist', () => {
    const source = dish('original', 'Original recipe');
    const spoon = {
      ...dish('spoonacular:1', 'Transient recipe'),
      source: { type: 'imported' as const, name: 'Spoonacular' },
    };
    const ai = { ...dish('draft', 'Generated draft'), source: { type: 'ai' as const } };
    expect(getStarterRecipes([spoon, ai, source, source])).toEqual([source]);
    expect(recommendRecipes([spoon, ai, source, source], empty)).toEqual([source]);
  });

  it('keeps explicit ingredient exclusions when an unfamiliar request falls back to starter dishes', () => {
    const peanut = dish('peanut', 'Peanut noodles', 'Peanut butter');
    const chicken = dish('chicken', 'Chicken dinner');
    const dairy = dish('dairy', 'Creamy pasta', 'Heavy cream');
    const recipes = [peanut, chicken, dairy];
    for (const query of [
      'no peanuts',
      'without peanuts',
      'avoid peanuts',
      'I am allergic to peanuts',
    ]) {
      expect(recommendRecipes(recipes, empty, { query }).map(({ id }) => id)).toEqual([
        'chicken',
        'dairy',
      ]);
    }
    expect(
      recommendRecipes(recipes, empty, {
        query: 'Unfindable request without peanuts and dairy',
        fallbackToStarters: true,
      }),
    ).toEqual([chicken]);
    expect(
      recommendRecipes([peanut], empty, {
        query: 'Unfindable request without peanuts',
        fallbackToStarters: true,
      }),
    ).toEqual([]);
    expect(recommendRecipes([peanut], empty, { query: 'no peas' })).toEqual([peanut]);
  });

  it('offers several dish families for a broad request without blocking a focused pasta request', () => {
    const recipes = [
      ...Array.from({ length: 6 }, (_, index) => ({
        ...dish(`pasta${index}`, `Pasta ${index}`),
        category: 'Pasta',
      })),
      ...Array.from({ length: 4 }, (_, index) => ({
        ...dish(`rice${index}`, `Rice ${index}`),
        category: 'Rice',
      })),
    ];
    const broad = recommendRecipes(recipes, empty, { limit: 8 });
    expect(broad.slice(0, 4).map((recipe) => recipe.category)).toEqual([
      'Pasta',
      'Pasta',
      'Rice',
      'Rice',
    ]);
    const focused = recommendRecipes(recipes, empty, { query: 'pasta', limit: 8 });
    expect(focused).toHaveLength(6);
    expect(focused.every((recipe) => recipe.category === 'Pasta')).toBe(true);
  });

  it('falls back to a custom library and preserves unknown yield and ingredient measures', () => {
    const unknown = {
      ...dish('custom', 'Custom soup'),
      servings: null,
      ingredients: [{ name: 'Salt', quantity: null, unit: '', original: 'Salt to taste' }],
    };
    expect(getStarterRecipes([unknown])).toEqual([unknown]);
    expect(recommendRecipes([unknown], empty)[0]).toBe(unknown);
    expect(unknown.servings).toBeNull();
    expect(unknown.ingredients[0].quantity).toBeNull();
    expect(recommendRecipes([unknown], empty, { limit: 0 })).toEqual([]);
    expect(recommendRecipes([unknown], empty, { limit: Number.NaN })).toEqual([unknown]);
  });

  it('honors expiration as an explicit preference without counting past-date stock', () => {
    const recipes = [dish('apple', 'Apple dish', 'Apples'), dish('chicken', 'Chicken dish')];
    const inventory: InventoryState = {
      products: [{ id: 'p', name: 'Chicken breast', isStaple: false }],
      batches: [
        {
          id: 'b',
          productId: 'p',
          location: 'fridge',
          quantity: 100,
          unit: 'g',
          purchasedOn: '2026-10-01',
          expiresOn: '2026-10-11',
        },
      ],
      tools: [],
    };
    expect(
      recommendRecipes(recipes, inventory, { today: '2026-10-10', prioritizeExpiration: true })[0]
        .id,
    ).toBe('chicken');
    expect(
      recommendRecipes(recipes, inventory, { today: '2026-10-12', prioritizeExpiration: true })[0]
        .id,
    ).toBe('apple');
  });
});
