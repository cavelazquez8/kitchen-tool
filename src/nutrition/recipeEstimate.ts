import type { Recipe } from '../recipes/types';
import type { RecipeNutritionMapping } from './types';
import { estimateRecipeNutrition } from './estimate';

/** Stale reviewed data is kept for correction but never used as current nutrition. */
export function reviewedRecipeEstimate(recipe: Recipe, mapping?: RecipeNutritionMapping) {
  if (!mapping) return null;
  try {
    return estimateRecipeNutrition(recipe, {
      recipeKey: mapping.recipeKey,
      ingredients: mapping.ingredients,
    });
  } catch {
    return null;
  }
}
