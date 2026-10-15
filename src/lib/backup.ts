import { isInventoryState, type InventoryState } from '../domain/types';
import { copyRecipeMetadata, type Recipe } from '../recipes/types';
import { copyNutritionValues, copyRecipeNutritionMapping } from '../nutrition/types';
import { copyBodyScan } from '../profile/types';

export interface InventoryBackup {
  version: 2;
  inventory: InventoryState;
}

function copyRecipe(recipe: Recipe): Recipe {
  return {
    id: recipe.id,
    title: recipe.title,
    servings: recipe.servings,
    ingredients: recipe.ingredients.map((ingredient) => ({
      name: ingredient.name,
      quantity: ingredient.quantity,
      unit: ingredient.unit,
      ...(ingredient.original === undefined ? {} : { original: ingredient.original }),
      ...(ingredient.optional === undefined ? {} : { optional: ingredient.optional }),
    })),
    steps: [...recipe.steps],
    source: {
      type: recipe.source.type,
      ...(recipe.source.url === undefined ? {} : { url: recipe.source.url }),
      ...(recipe.source.name === undefined ? {} : { name: recipe.source.name }),
      ...(recipe.source.attribution === undefined
        ? {}
        : { attribution: recipe.source.attribution }),
      ...(recipe.source.license === undefined ? {} : { license: recipe.source.license }),
      ...(recipe.source.licenseUrl === undefined ? {} : { licenseUrl: recipe.source.licenseUrl }),
    },
    ...copyRecipeMetadata(recipe),
  };
}

/**
 * Export kitchen data only. Explicit nested allowlists prevent future connection
 * settings or unknown fields from leaking credentials into transferable backups.
 * User-authored recipe/conversation text remains part of the user's kitchen data.
 */
export function buildInventoryBackup(state: InventoryState): InventoryBackup {
  if (!isInventoryState(state))
    throw new Error(
      'Your kitchen data could not be exported. Please check it before downloading a backup.',
    );
  const inventory: InventoryState = {
    products: state.products.map((product) => ({
      id: product.id,
      name: product.name,
      isStaple: product.isStaple,
      ...(product.barcode === undefined ? {} : { barcode: product.barcode }),
      ...(product.brand === undefined ? {} : { brand: product.brand }),
      ...(product.ingredientName === undefined ? {} : { ingredientName: product.ingredientName }),
      ...(product.packageQuantity === undefined
        ? {}
        : {
            packageQuantity: {
              quantity: product.packageQuantity.quantity,
              unit: product.packageQuantity.unit,
            },
          }),
    })),
    batches: state.batches.map((batch) => ({
      id: batch.id,
      productId: batch.productId,
      location: batch.location,
      quantity: batch.quantity,
      unit: batch.unit,
      purchasedOn: batch.purchasedOn,
      expiresOn: batch.expiresOn,
      ...(batch.stapleStatus === undefined ? {} : { stapleStatus: batch.stapleStatus }),
    })),
    tools: state.tools.map((tool) => ({ id: tool.id, name: tool.name })),
    ...(state.recipes === undefined ? {} : { recipes: state.recipes.map(copyRecipe) }),
    ...(state.mealPlan === undefined
      ? {}
      : {
          mealPlan: state.mealPlan.map((item) => ({
            recipeId: item.recipeId,
            servings: item.servings,
          })),
        }),
    ...(state.shoppingList === undefined
      ? {}
      : {
          shoppingList: state.shoppingList.map((item) => ({
            id: item.id,
            name: item.name,
            quantity: item.quantity,
            unit: item.unit,
            checked: item.checked,
            status: item.status,
            ...(item.note === undefined ? {} : { note: item.note }),
            ...(item.addedBatchId === undefined ? {} : { addedBatchId: item.addedBatchId }),
          })),
        }),
    ...(state.chatHistory === undefined
      ? {}
      : {
          chatHistory: state.chatHistory.map((message) => ({
            id: message.id,
            role: message.role,
            text: message.text,
          })),
        }),
    ...(state.assistantSession === undefined
      ? {}
      : {
          assistantSession: {
            recipes: state.assistantSession.recipes.map(copyRecipe),
            attachedRecipes: state.assistantSession.attachedRecipes.map(copyRecipe),
            draft: state.assistantSession.draft,
            mode: state.assistantSession.mode,
            ...(state.assistantSession.bodyScanIds
              ? { bodyScanIds: [...state.assistantSession.bodyScanIds] }
              : {}),
          },
        }),
    ...(state.nutritionTargets === undefined
      ? {}
      : { nutritionTargets: copyNutritionValues(state.nutritionTargets) }),
    ...(state.bodyScans === undefined ? {} : { bodyScans: state.bodyScans.map(copyBodyScan) }),
    ...(state.recipeNutrition === undefined
      ? {}
      : {
          recipeNutrition: state.recipeNutrition.map((item) => ({
            recipeId: item.recipeId,
            ...copyRecipeNutritionMapping(item),
          })),
        }),
  };
  return { version: 2, inventory };
}
