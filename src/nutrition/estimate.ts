import type { Recipe } from '../recipes/types';
import {
  EMPTY_NUTRITION_TARGETS,
  isRecipeNutritionMapping,
  NUTRITION_KEYS,
  type NutritionKey,
  type NutritionValues,
  type RecipeNutritionMapping,
} from './types';

export interface RecipeNutritionEstimate {
  /** A field is null if any recipe ingredient has unknown data for it. */
  totals: NutritionValues;
  perServing: NutritionValues | null;
  /** The recorded part only; must never be presented as the complete recipe. */
  knownSubtotal: NutritionValues;
  mappedIngredientCount: number;
  ingredientCount: number;
  missingIngredientIndexes: number[];
  missingNutrients: NutritionKey[];
  sourceFoodIds: number[];
  complete: boolean;
}

export function recipeNutritionKey(recipe: Recipe): string {
  return JSON.stringify({
    servings: recipe.servings,
    ingredients: recipe.ingredients.map(({ name, quantity, unit, original, optional }) => ({
      name,
      quantity,
      unit,
      ...(original === undefined ? {} : { original }),
      ...(optional === undefined ? {} : { optional }),
    })),
  });
}

/** Only confirmed food identities and edible weights contribute; no volume/count guesses. */
export function estimateRecipeNutrition(
  recipe: Recipe,
  mapping: RecipeNutritionMapping,
): RecipeNutritionEstimate {
  if (
    !isRecipeNutritionMapping(mapping) ||
    mapping.recipeKey !== recipeNutritionKey(recipe) ||
    mapping.ingredients.some(({ ingredientIndex }) => ingredientIndex >= recipe.ingredients.length)
  )
    throw new Error('Review nutrition matches again because this recipe has changed.');

  const mapped = new Map(
    mapping.ingredients.map((ingredient) => [ingredient.ingredientIndex, ingredient]),
  );
  const missingIngredientIndexes = recipe.ingredients.flatMap((_, index) =>
    mapped.has(index) ? [] : [index],
  );
  const totals: NutritionValues = { ...EMPTY_NUTRITION_TARGETS };
  const knownSubtotal: NutritionValues = { ...EMPTY_NUTRITION_TARGETS };
  const missingNutrients: NutritionKey[] = [];
  for (const key of NUTRITION_KEYS) {
    let sum = 0;
    let known = 0;
    let missing = missingIngredientIndexes.length > 0;
    for (const { food, grams } of mapping.ingredients) {
      // Explicitly confirmed zero grams means the ingredient was omitted.
      const value = grams === 0 ? 0 : food.per100g[key];
      if (value === null) missing = true;
      else {
        sum += (value * grams) / 100;
        known++;
      }
    }
    knownSubtotal[key] = known ? sum : null;
    totals[key] = missing || known === 0 ? null : sum;
    if (totals[key] === null) missingNutrients.push(key);
  }
  let perServing: NutritionValues | null = null;
  const servings = recipe.servings;
  if (servings !== null && Number.isFinite(servings) && servings > 0) {
    perServing = { ...EMPTY_NUTRITION_TARGETS };
    for (const key of NUTRITION_KEYS) {
      const total = totals[key];
      perServing[key] = total === null ? null : total / servings;
    }
  }
  return {
    totals,
    perServing,
    knownSubtotal,
    mappedIngredientCount: mapped.size,
    ingredientCount: recipe.ingredients.length,
    missingIngredientIndexes,
    missingNutrients,
    sourceFoodIds: [
      ...new Set(
        mapping.ingredients.filter(({ grams }) => grams > 0).map(({ food }) => food.fdcId),
      ),
    ],
    complete: missingIngredientIndexes.length === 0 && missingNutrients.length === 0,
  };
}
