import { describe, expect, it } from 'vitest';
import { copyRecipeMetadata, isRecipe, type Recipe } from './types';

const recipe: Recipe = {
  id: 'metadata-recipe',
  title: 'Eggs',
  servings: 2,
  ingredients: [{ name: 'eggs', quantity: 2, unit: 'each' }],
  steps: ['Cook the eggs.'],
  source: { type: 'imported', url: 'https://example.com/eggs' },
};

describe('publisher recipe metadata validation', () => {
  it('keeps existing backups valid and accepts explicit publisher values', () => {
    expect(isRecipe(recipe)).toBe(true);
    expect(
      isRecipe({
        ...recipe,
        author: 'Publisher Author',
        totalMinutes: 25,
        rating: { value: 4.5, best: 5, count: 100 },
        publisherNutrition: { calories: '250 kcal', protein: '20 g', servingSize: '1 serving' },
      }),
    ).toBe(true);
  });

  it('rejects malformed or unsafe new metadata from transferable files', () => {
    for (const metadata of [
      { totalMinutes: -1 },
      { prepMinutes: Number.POSITIVE_INFINITY },
      { author: '' },
      { rating: { value: 6, best: 5 } },
      { rating: { value: 4, count: 1.5 } },
      { publisherNutrition: {} },
      { publisherNutrition: { calories: 250 } },
      { publisherNutrition: { protein: 'x'.repeat(121) } },
      { imageUrl: 'javascript:alert(1)' },
    ])
      expect(isRecipe({ ...recipe, ...metadata })).toBe(false);
  });

  it('copies only the allowed metadata and clones nested rating and nutrition records', () => {
    const source = {
      author: 'Publisher Author',
      totalMinutes: 25,
      rating: { value: 4.5, best: 5, count: 100, token: 'do not export' },
      publisherNutrition: { calories: '250 kcal', token: 'do not export' },
      secret: 'do not export',
    };
    const copied = copyRecipeMetadata(source);
    expect(copied).toEqual({
      author: 'Publisher Author',
      totalMinutes: 25,
      rating: { value: 4.5, best: 5, count: 100 },
      publisherNutrition: { calories: '250 kcal' },
    });
    expect(copied.rating).not.toBe(source.rating);
    expect(copied.publisherNutrition).not.toBe(source.publisherNutrition);
  });
});
