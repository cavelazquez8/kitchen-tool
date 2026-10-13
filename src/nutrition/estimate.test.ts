import { describe, expect, it } from 'vitest';
import type { Recipe } from '../recipes/types';
import { estimateRecipeNutrition, recipeNutritionKey } from './estimate';
import {
  EMPTY_NUTRITION_TARGETS,
  isFoodNutrition,
  isNutritionTargets,
  isRecipeNutritionMapping,
  type FoodNutrition,
  type RecipeNutritionMapping,
} from './types';

const recipe: Recipe = {
  id: 'nutrition-test-only',
  title: 'Synthetic fixture meal',
  servings: 2,
  ingredients: [
    { name: 'Fixture raw chicken', quantity: 200, unit: 'g' },
    { name: 'Fixture dry rice', quantity: 100, unit: 'g' },
  ],
  steps: ['Test fixture only.'],
  source: { type: 'manual' },
};
const chicken: FoodNutrition = {
  fdcId: 1,
  description: 'Synthetic fixture raw chicken',
  dataType: 'Foundation',
  sourceUrl: 'https://fdc.nal.usda.gov/food-details/1/nutrients',
  per100g: { caloriesKcal: 100, proteinGrams: 20, carbsGrams: 0, fatGrams: 2 },
  portions: [{ label: 'Source fixture portion', gramWeight: 150 }],
};
const rice: FoodNutrition = {
  ...chicken,
  fdcId: 2,
  sourceUrl: 'https://fdc.nal.usda.gov/food-details/2/nutrients',
  description: 'Synthetic fixture dry rice',
  per100g: { caloriesKcal: 300, proteinGrams: 6, carbsGrams: 70, fatGrams: 1 },
};
const mapping = (): RecipeNutritionMapping => ({
  recipeKey: recipeNutritionKey(recipe),
  ingredients: [
    { ingredientIndex: 0, food: chicken, grams: 200, confirmed: true },
    { ingredientIndex: 1, food: rice, grams: 100, confirmed: true },
  ],
});

describe('source-backed recipe nutrition estimates', () => {
  it('uses confirmed edible grams and the recorded yield without modifying the recipe', () => {
    const before = structuredClone(recipe);
    const result = estimateRecipeNutrition(recipe, mapping());
    expect(result.totals).toEqual({
      caloriesKcal: 500,
      proteinGrams: 46,
      carbsGrams: 70,
      fatGrams: 5,
    });
    expect(result.perServing).toEqual({
      caloriesKcal: 250,
      proteinGrams: 23,
      carbsGrams: 35,
      fatGrams: 2.5,
    });
    expect(result.complete).toBe(true);
    expect(result.sourceFoodIds).toEqual([1, 2]);
    expect(recipe).toEqual(before);
  });

  it('leaves a whole-recipe nutrient unknown when one ingredient is not reviewed', () => {
    const input = mapping();
    input.ingredients.pop();
    const result = estimateRecipeNutrition(recipe, input);
    expect(result.complete).toBe(false);
    expect(result.totals).toEqual(EMPTY_NUTRITION_TARGETS);
    expect(result.perServing).toEqual(EMPTY_NUTRITION_TARGETS);
    expect(result.knownSubtotal.caloriesKcal).toBe(200);
    expect(result.missingIngredientIndexes).toEqual([1]);
  });

  it('preserves missing source nutrients instead of substituting zero', () => {
    const input = mapping();
    input.ingredients[1].food = { ...rice, per100g: { ...rice.per100g, proteinGrams: null } };
    const result = estimateRecipeNutrition(recipe, input);
    expect(result.totals.caloriesKcal).toBe(500);
    expect(result.totals.proteinGrams).toBeNull();
    expect(result.knownSubtotal.proteinGrams).toBe(40);
    expect(result.missingNutrients).toEqual(['proteinGrams']);
    expect(result.complete).toBe(false);
  });

  it('does not invent a per-serving estimate when source yield is unknown', () => {
    const unknownYield = { ...recipe, servings: null };
    expect(
      estimateRecipeNutrition(unknownYield, {
        ...mapping(),
        recipeKey: recipeNutritionKey(unknownYield),
      }).perServing,
    ).toBeNull();
  });

  it('requires review after edits to quantities, ingredient order, or yield', () => {
    for (const edited of [
      { ...recipe, servings: 4 },
      { ...recipe, ingredients: [...recipe.ingredients].reverse() },
      {
        ...recipe,
        ingredients: [{ ...recipe.ingredients[0], quantity: 500 }, recipe.ingredients[1]],
      },
    ])
      expect(() => estimateRecipeNutrition(edited, mapping())).toThrow('recipe has changed');
  });

  it('rejects unconfirmed, duplicate, non-finite, and out-of-range matches', () => {
    const initial = mapping();
    expect(
      isRecipeNutritionMapping({
        ...initial,
        ingredients: [initial.ingredients[0], initial.ingredients[0]],
      }),
    ).toBe(false);
    for (const grams of [-1, Infinity, NaN])
      expect(
        isRecipeNutritionMapping({
          ...initial,
          ingredients: [{ ...initial.ingredients[0], grams }],
        }),
      ).toBe(false);
    expect(
      isRecipeNutritionMapping({
        ...initial,
        ingredients: [{ ...initial.ingredients[0], confirmed: false }],
      }),
    ).toBe(false);
    expect(() =>
      estimateRecipeNutrition(recipe, {
        ...initial,
        ingredients: [{ ...initial.ingredients[0], ingredientIndex: 8 }],
      }),
    ).toThrow();
  });

  it('accepts explicit omission without adding unknown nutrition', () => {
    const input = mapping();
    input.ingredients[1] = {
      ...input.ingredients[1],
      grams: 0,
      food: { ...rice, per100g: { ...EMPTY_NUTRITION_TARGETS } },
    };
    expect(estimateRecipeNutrition(recipe, input).totals.caloriesKcal).toBe(200);
    expect(estimateRecipeNutrition(recipe, input).complete).toBe(true);
  });
});

describe('nutrition persistence validation', () => {
  it('accepts optional user goals but rejects unit strings, missing fields, unknown properties, or invalid amounts', () => {
    expect(isNutritionTargets(EMPTY_NUTRITION_TARGETS)).toBe(true);
    expect(isNutritionTargets({ ...EMPTY_NUTRITION_TARGETS, proteinGrams: 120 })).toBe(true);
    for (const invalid of [
      { caloriesKcal: 2000 },
      { ...EMPTY_NUTRITION_TARGETS, caloriesKcal: '2000 kcal' },
      { ...EMPTY_NUTRITION_TARGETS, caloriesKcal: 0 },
      { ...EMPTY_NUTRITION_TARGETS, fatGrams: -1 },
      { ...EMPTY_NUTRITION_TARGETS, apiKey: 'not allowed' },
    ])
      expect(isNutritionTargets(invalid)).toBe(false);
  });

  it('pins attribution to the food ID and does not accept unrelated source URLs or secrets', () => {
    expect(isFoodNutrition(chicken)).toBe(true);
    expect(isFoodNutrition({ ...chicken, sourceUrl: 'https://attacker.example' })).toBe(false);
    expect(isFoodNutrition({ ...chicken, apiKey: 'not allowed' })).toBe(false);
  });
});
