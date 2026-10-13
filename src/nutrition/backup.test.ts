import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyInventory, isInventoryState, type InventoryState } from '../domain/types';
import { buildInventoryBackup } from '../lib/backup';
import { createLocalRepository } from '../lib/localRepository';
import type { Recipe } from '../recipes/types';
import { recipeNutritionKey } from './estimate';
import type { FoodNutrition } from './types';

const recipe: Recipe = {
  id: 'nutrition-backup-fixture',
  title: 'Synthetic fixture recipe',
  servings: 2,
  ingredients: [{ name: 'Fixture food', quantity: 100, unit: 'g' }],
  steps: ['Test fixture only.'],
  source: { type: 'manual' },
};
const food: FoodNutrition = {
  fdcId: 123,
  description: 'Synthetic fixture food',
  dataType: 'Foundation',
  sourceUrl: 'https://fdc.nal.usda.gov/food-details/123/nutrients',
  per100g: { caloriesKcal: 100, proteinGrams: null, carbsGrams: 0, fatGrams: 2 },
  portions: [],
};
const state = (): InventoryState => ({
  ...createEmptyInventory(),
  recipes: [recipe],
  nutritionTargets: { caloriesKcal: 2000, proteinGrams: 120, carbsGrams: null, fatGrams: null },
  recipeNutrition: [
    {
      recipeId: recipe.id,
      recipeKey: recipeNutritionKey(recipe),
      ingredients: [{ ingredientIndex: 0, food, grams: 100, confirmed: true }],
    },
  ],
});
afterEach(() => localStorage.clear());

describe('nutrition backups and local persistence', () => {
  it('round trips goals and reviewed USDA data, preserving unknown nutrients and source IDs', async () => {
    const original = state();
    const backup = buildInventoryBackup(original);
    expect(backup.inventory.nutritionTargets).toEqual(original.nutritionTargets);
    expect(backup.inventory.recipeNutrition).toEqual(original.recipeNutrition);
    expect(isInventoryState(backup.inventory)).toBe(true);
    const repository = createLocalRepository(localStorage);
    await repository.replace(JSON.parse(JSON.stringify(backup.inventory)));
    expect(createLocalRepository(localStorage).getSnapshot().state).toEqual(original);
  });

  it('does not export pairing credentials or unrelated top-level properties', () => {
    const input = {
      ...state(),
      USDA_API_KEY: 'test-only-secret',
      geminiConnection: { token: 'test-only-token' },
    };
    const backup = buildInventoryBackup(input);
    expect(JSON.stringify(backup)).not.toContain('test-only-secret');
    expect(JSON.stringify(backup)).not.toContain('test-only-token');
    expect(backup.inventory.recipeNutrition?.[0].ingredients[0].food.sourceUrl).toContain('/123/');
  });

  it('rejects malformed targets or unconfirmed food mappings before replacing existing data', async () => {
    const repository = createLocalRepository(localStorage);
    await repository.replace(state());
    for (const broken of [
      { ...state(), nutritionTargets: { caloriesKcal: 2000 } },
      {
        ...state(),
        recipeNutrition: [
          {
            ...state().recipeNutrition![0],
            ingredients: [{ ...state().recipeNutrition![0].ingredients[0], confirmed: false }],
          },
        ],
      },
      { ...state(), recipeNutrition: [state().recipeNutrition![0], state().recipeNutrition![0]] },
    ]) {
      expect(isInventoryState(broken)).toBe(false);
      await expect(repository.replace(broken as InventoryState)).rejects.toThrow('not a valid');
    }
    expect(repository.getSnapshot().state).toEqual(state());
  });
});
