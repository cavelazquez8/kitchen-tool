import { convertQuantity } from '../domain/inventory';
import type { Batch, InventoryState } from '../domain/types';
import type { Recipe, RecipeIngredient, RecipeSelection } from './types';

const ALIASES: Record<string, string> = {
  eggs: 'egg',
  tomatoes: 'tomato',
  potatoes: 'potato',
  onions: 'onion',
  carrots: 'carrot',
  bananas: 'banana',
  apples: 'apple',
  lemons: 'lemon',
  limes: 'lime',
  oranges: 'orange',
  cucumbers: 'cucumber',
  peppers: 'pepper',
  mushrooms: 'mushroom',
  strawberries: 'strawberry',
  blueberries: 'blueberry',
  raspberries: 'raspberry',
  avocados: 'avocado',
  courgette: 'zucchini',
  courgettes: 'zucchini',
  aubergine: 'eggplant',
  aubergines: 'eggplant',
  scallions: 'green onion',
  'spring onion': 'green onion',
  'spring onions': 'green onion',
  'green onions': 'green onion',
  'chicken breasts': 'chicken breast',
  'chicken thighs': 'chicken thigh',
  'garlic cloves': 'garlic',
  'garlic clove': 'garlic',
  'plain flour': 'all purpose flour',
  'all-purpose flour': 'all purpose flour',
  'bicarbonate of soda': 'baking soda',
  'caster sugar': 'superfine sugar',
  'icing sugar': 'powdered sugar',
};
export function canonicalIngredientName(value: string): string {
  const name = value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, '')
    .replace(/[_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return ALIASES[name] ?? name;
}
function converted(amount: number, from: string, to: string): number | null {
  try {
    return convertQuantity(amount, from, to);
  } catch {
    return null;
  }
}
function localDate(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
function round(amount: number): number {
  return Math.round(amount * 1e9) / 1e9;
}
export interface MatchOptions {
  today?: string;
  excludeExpired?: boolean;
  selectedProductIds?: readonly string[];
  prioritizeExpiration?: boolean;
}
export interface IngredientMatch {
  ingredient: RecipeIngredient;
  status: 'available' | 'missing' | 'short' | 'check';
  required: number | null;
  available: number | null;
  shortage: number | null;
  reason?: string;
  recipeIds: string[];
}
export interface RecipeMatch {
  recipe: Recipe;
  status: 'ready' | 'almost' | 'check';
  ingredients: IngredientMatch[];
  missingCount: number;
  uncertainCount: number;
  matchedCount: number;
  useSoonCount: number;
  warnings: string[];
}
interface Demand {
  ingredient: RecipeIngredient;
  recipeIds: string[];
}

function demandsFor(selections: readonly RecipeSelection[]): {
  demands: Demand[];
  warnings: string[];
} {
  const demands: Demand[] = [];
  const warnings: string[] = [];
  for (const { recipe, servings } of selections) {
    const validTarget = servings !== undefined && Number.isFinite(servings) && servings > 0;
    const scale = validTarget && recipe.servings !== null ? servings! / recipe.servings : 1;
    if (servings !== undefined && !validTarget)
      warnings.push(`${recipe.title}: enter a serving count greater than zero.`);
    if (validTarget && recipe.servings === null)
      warnings.push(
        `${recipe.title}: serving yield is unknown; quantities are for the original recipe. Set its yield before scaling.`,
      );
    for (const raw of recipe.ingredients) {
      if (raw.optional || raw.quantity === 0) continue;
      const cannotScale =
        (validTarget && recipe.servings === null) || (servings !== undefined && !validTarget);
      const ingredient = {
        ...raw,
        quantity: raw.quantity === null || cannotScale ? null : round(raw.quantity * scale),
      };
      const key = canonicalIngredientName(raw.name);
      const existing = demands.find(
        (demand) =>
          canonicalIngredientName(demand.ingredient.name) === key &&
          (demand.ingredient.unit === ingredient.unit ||
            converted(1, ingredient.unit, demand.ingredient.unit) !== null),
      );
      if (existing) {
        if (existing.ingredient.quantity === null || ingredient.quantity === null)
          existing.ingredient.quantity = null;
        else
          existing.ingredient.quantity = round(
            existing.ingredient.quantity +
              converted(ingredient.quantity, ingredient.unit, existing.ingredient.unit)!,
          );
        if (!existing.recipeIds.includes(recipe.id)) existing.recipeIds.push(recipe.id);
      } else demands.push({ ingredient, recipeIds: [recipe.id] });
    }
  }
  return { demands, warnings };
}

function eligibleBatches(
  inventory: InventoryState,
  name: string,
  options: MatchOptions,
): { batches: Batch[]; expired: boolean } {
  const selected = options.selectedProductIds ? new Set(options.selectedProductIds) : null;
  const productIds = new Set(
    inventory.products
      .filter(
        (product) =>
          (!selected || selected.has(product.id)) &&
          canonicalIngredientName(product.ingredientName ?? product.name) === name,
      )
      .map((product) => product.id),
  );
  const today = options.today ?? localDate();
  let expired = false;
  const batches = inventory.batches.filter((batch) => {
    const product = inventory.products.find((item) => item.id === batch.productId);
    const assumedStocked = product?.isStaple && (batch.stapleStatus ?? 'stocked') === 'stocked';
    if (
      !productIds.has(batch.productId) ||
      batch.stapleStatus === 'empty' ||
      (batch.quantity === 0 && !assumedStocked)
    )
      return false;
    if (batch.expiresOn && batch.expiresOn < today && options.excludeExpired !== false) {
      expired = true;
      return false;
    }
    return true;
  });
  return { batches, expired };
}
function compareDemand(
  demand: Demand,
  inventory: InventoryState,
  options: MatchOptions,
): IngredientMatch {
  const { ingredient, recipeIds } = demand;
  const { batches, expired } = eligibleBatches(
    inventory,
    canonicalIngredientName(ingredient.name),
    options,
  );
  const base = { ingredient, recipeIds, required: ingredient.quantity };
  if (batches.length === 0)
    return {
      ...base,
      status: 'missing',
      available: 0,
      shortage: ingredient.quantity,
      ...(expired ? { reason: 'Only past-date stock is recorded. Check it before using.' } : {}),
    };
  const stockedStaple = batches.some(
    (batch) =>
      inventory.products.some((product) => product.id === batch.productId && product.isStaple) &&
      (batch.stapleStatus ?? 'stocked') === 'stocked',
  );
  if (stockedStaple)
    return {
      ...base,
      status: 'available',
      available: null,
      shortage: 0,
      reason: 'Assumed stocked until you mark this staple low or empty.',
    };
  let available = 0;
  let unknown = false;
  for (const batch of batches) {
    const value =
      batch.quantity === null ? null : converted(batch.quantity, batch.unit, ingredient.unit);
    if (value === null) unknown = true;
    else available += value;
  }
  available = round(available);
  if (ingredient.quantity === null)
    return {
      ...base,
      status: 'check',
      available: unknown ? null : available,
      shortage: null,
      reason: 'The recipe does not specify a precise amount.',
    };
  if (available + 1e-9 >= ingredient.quantity)
    return { ...base, status: 'available', available, shortage: 0 };
  if (unknown)
    return {
      ...base,
      status: 'check',
      available: available > 0 ? available : null,
      shortage: null,
      reason: 'Check the recorded amount or package size; units cannot be safely compared.',
    };
  return {
    ...base,
    status: 'short',
    available,
    shortage: round(Math.max(0, ingredient.quantity - available)),
  };
}

export function matchRecipe(
  recipe: Recipe,
  inventory: InventoryState,
  options: MatchOptions & { servings?: number } = {},
): RecipeMatch {
  const { demands, warnings } = demandsFor([{ recipe, servings: options.servings }]);
  const ingredients = demands.map((demand) => compareDemand(demand, inventory, options));
  const missingCount = ingredients.filter(
    (item) => item.status === 'missing' || item.status === 'short',
  ).length;
  const uncertainCount =
    ingredients.filter((item) => item.status === 'check').length + (warnings.length > 0 ? 1 : 0);
  const matchedCount = ingredients.filter(
    (item) => item.status === 'available' || item.status === 'check',
  ).length;
  const today = options.today ?? localDate();
  const cutoff = new Date(`${today}T12:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() + 3);
  const soon = cutoff.toISOString().slice(0, 10);
  const useSoonCount = demands.filter((demand) =>
    eligibleBatches(
      inventory,
      canonicalIngredientName(demand.ingredient.name),
      options,
    ).batches.some(
      (batch) => batch.expiresOn && batch.expiresOn >= today && batch.expiresOn <= soon,
    ),
  ).length;
  return {
    recipe,
    ingredients,
    missingCount,
    uncertainCount,
    matchedCount,
    useSoonCount,
    warnings,
    status: missingCount > 0 ? 'almost' : uncertainCount > 0 ? 'check' : 'ready',
  };
}

export function rankRecipes(
  recipes: readonly Recipe[],
  inventory: InventoryState,
  options: MatchOptions = {},
): RecipeMatch[] {
  return recipes
    .map((recipe) => matchRecipe(recipe, inventory, options))
    .sort((a, b) => {
      const tier = { ready: 0, check: 1, almost: 2 };
      return (
        tier[a.status] - tier[b.status] ||
        a.missingCount - b.missingCount ||
        b.matchedCount - a.matchedCount ||
        (options.prioritizeExpiration ? b.useSoonCount - a.useSoonCount : 0) ||
        a.uncertainCount - b.uncertainCount ||
        a.recipe.title.localeCompare(b.recipe.title)
      );
    });
}

export interface ShoppingRequirement {
  id: string;
  name: string;
  quantity: number | null;
  unit: string;
  required: number | null;
  available: number | null;
  status: 'missing' | 'check';
  recipeIds: string[];
  reason?: string;
}
export interface ShoppingListResult {
  items: ShoppingRequirement[];
  warnings: string[];
}

/** Aggregate all meals first, then subtract each compatible inventory supply once. */
export function buildShoppingList(
  selections: readonly RecipeSelection[],
  inventory: InventoryState,
  options: MatchOptions = {},
): ShoppingListResult {
  const { demands, warnings } = demandsFor(selections);
  const items: ShoppingRequirement[] = [];
  for (const demand of demands) {
    const match = compareDemand(demand, inventory, options);
    if (match.status === 'available') continue;
    items.push({
      id: `${canonicalIngredientName(demand.ingredient.name)}:${demand.ingredient.unit}`,
      name: demand.ingredient.name,
      quantity: match.shortage,
      unit: demand.ingredient.unit,
      required: match.required,
      available: match.available,
      status: match.status === 'check' || match.shortage === null ? 'check' : 'missing',
      recipeIds: demand.recipeIds,
      ...(match.reason ? { reason: match.reason } : {}),
    });
  }
  return { items, warnings };
}
