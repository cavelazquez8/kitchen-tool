import { isRecord } from '../ai/protocol';
import { parseIngredientLine } from './parse';
import { isRecipe, type Recipe } from './types';

export type RecipeProviderId = 'recipeapi' | 'spoonacular';
export type RecipeProviderStorage = 'personal' | 'session';

export interface RecipeProviderStatus {
  id: RecipeProviderId;
  name: string;
  configured: boolean;
  storage: RecipeProviderStorage;
  freeAllowance: string;
  setupUrl: string;
}

export interface RecipeProviderSearch {
  provider: RecipeProviderId;
  query: string;
  ingredients?: string[];
  page?: number;
  limit?: number;
}

export interface RecipeProviderResults {
  provider: RecipeProviderId;
  recipes: Recipe[];
  page: number;
  hasMore: boolean;
  storage: RecipeProviderStorage;
  expiresAt?: number;
  warnings: string[];
}

export const RECIPE_PROVIDER_INFO: readonly Omit<RecipeProviderStatus, 'configured'>[] = [
  {
    id: 'recipeapi',
    name: 'RecipeAPI.io',
    storage: 'personal',
    freeAllowance: '500 requests/month · 10 recipes per search',
    setupUrl: 'https://recipeapi.io/register',
  },
  {
    id: 'spoonacular',
    name: 'Spoonacular',
    storage: 'session',
    freeAllowance: '50 points/day · online discovery only',
    setupUrl: 'https://spoonacular.com/food-api/console#Dashboard',
  },
];

function text(value: unknown, limit = 200): string {
  return typeof value === 'string' && value.trim().length <= limit ? value.trim() : '';
}

function safeUrl(value: unknown): string | undefined {
  try {
    const parsed = new URL(text(value, 2000));
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
}

function quantity(value: unknown): number | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100000)
    return undefined;
  return value === 0 ? null : value;
}

function positiveId(value: unknown): string | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value)
      ? value
      : null;
}

export function parseRecipeProviderSearch(value: unknown): RecipeProviderSearch | null {
  if (
    !isRecord(value) ||
    !['recipeapi', 'spoonacular'].includes(String(value.provider)) ||
    Object.keys(value).some(
      (key) => !['provider', 'query', 'ingredients', 'page', 'limit'].includes(key),
    ) ||
    typeof value.query !== 'string' ||
    value.query.length > 120 ||
    (value.page !== undefined &&
      (!Number.isInteger(value.page) || Number(value.page) < 1 || Number(value.page) > 5000)) ||
    (value.limit !== undefined &&
      (!Number.isInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > 10))
  )
    return null;
  if (
    value.ingredients !== undefined &&
    (!Array.isArray(value.ingredients) ||
      value.ingredients.length > 60 ||
      !value.ingredients.every(
        (item) => typeof item === 'string' && text(item, 80) && !item.includes(','),
      ))
  )
    return null;
  const ingredients = value.ingredients as string[] | undefined;
  if (!value.query.trim() && !ingredients?.length) return null;
  const page = Number(value.page ?? 1);
  const limit = Number(value.limit ?? 10);
  if (value.provider === 'spoonacular' && (page - 1) * limit > 900) return null;
  return {
    provider: value.provider as RecipeProviderId,
    query: value.query.trim(),
    ...(ingredients ? { ingredients: [...new Set(ingredients.map((item) => item.trim()))] } : {}),
    page,
    limit,
  };
}

/** Keep original amounts intact; a malformed required ingredient rejects the entire recipe. */
export function recipeApiToRecipe(value: unknown): Recipe | null {
  if (!isRecord(value)) return null;
  const id = positiveId(value.id);
  if (!id || !Array.isArray(value.ingredients) || !Array.isArray(value.instructions)) return null;
  const ingredients: Recipe['ingredients'] = [];
  for (const item of value.ingredients) {
    if (!isRecord(item) || !text(item.name, 160)) return null;
    const amount = quantity(item.quantity);
    if (amount === undefined || (item.unit !== undefined && typeof item.unit !== 'string'))
      return null;
    if (item.optional !== undefined && typeof item.optional !== 'boolean') return null;
    const unit = text(item.unit, 40);
    if (typeof item.unit === 'string' && item.unit.trim().length > 40) return null;
    const original =
      text(item.original, 1000) ||
      [amount, unit, text(item.name, 160)].filter((part) => part !== null && part !== '').join(' ');
    ingredients.push({
      name: text(item.name, 160),
      quantity: amount,
      unit,
      original,
      ...(item.optional !== undefined ? { optional: item.optional } : {}),
    });
  }
  const servings = quantity(value.servings);
  if (servings === undefined || (servings !== null && servings > 100)) return null;
  if (!value.instructions.every((step) => text(step, 3000))) return null;
  const imageUrl = safeUrl(value.image_url);
  const recipe: Recipe = {
    id: `recipeapi:${id}`,
    title: text(value.name, 180),
    servings,
    ingredients,
    steps: value.instructions.map((step) => text(step, 3000)),
    source: {
      type: 'imported',
      name: 'RecipeAPI.io',
      url: safeUrl(value.source_url) ?? 'https://recipeapi.io/',
      attribution: `RecipeAPI.io · recipe ${id}`,
      license: 'Personal, non-commercial use under RecipeAPI.io Free terms',
      licenseUrl: 'https://recipeapi.io/legal/terms-of-service',
    },
    ...(imageUrl ? { imageUrl } : {}),
    ...(text(value.cuisine) ? { cuisine: text(value.cuisine) } : {}),
    ...(text(value.meal_type) ? { category: text(value.meal_type).replaceAll('_', ' ') } : {}),
  };
  return isRecipe(recipe) ? recipe : null;
}

/** Spoonacular records remain ephemeral. Source ingredients, including ambiguous originals, are preserved. */
export function spoonacularToRecipe(value: unknown): Recipe | null {
  if (!isRecord(value)) return null;
  const id = positiveId(value.id);
  if (
    !id ||
    !Array.isArray(value.extendedIngredients) ||
    !Array.isArray(value.analyzedInstructions)
  )
    return null;
  const ingredients: Recipe['ingredients'] = [];
  for (const item of value.extendedIngredients) {
    if (!isRecord(item) || !text(item.name, 160)) return null;
    const original = text(item.original, 1000);
    const parsed = original ? parseIngredientLine(original) : null;
    const rawAmount = quantity(item.amount);
    if (rawAmount === undefined || (item.unit !== undefined && typeof item.unit !== 'string'))
      return null;
    // The provider can turn "5–6 cloves" into 5; unparseable original measures stay unknown.
    const amount = parsed ? parsed.quantity : original ? null : rawAmount;
    ingredients.push({
      name: text(item.name, 160),
      quantity: amount,
      unit: parsed ? parsed.unit : text(item.unit, 40),
      ...(original ? { original } : {}),
      ...(parsed?.optional ? { optional: true } : {}),
    });
  }
  const steps: string[] = [];
  for (const section of value.analyzedInstructions) {
    if (!isRecord(section) || !Array.isArray(section.steps)) return null;
    if (text(section.name, 180)) steps.push(text(section.name, 180));
    for (const step of section.steps) {
      if (!isRecord(step) || !text(step.step, 3000)) return null;
      steps.push(text(step.step, 3000));
    }
  }
  const servings = quantity(value.servings);
  if (servings === undefined || (servings !== null && servings > 100)) return null;
  const imageUrl = safeUrl(value.image);
  const sourceUrl = safeUrl(value.sourceUrl) ?? safeUrl(value.spoonacularSourceUrl);
  if (!sourceUrl) return null;
  const recipe: Recipe = {
    id: `spoonacular:${id}`,
    title: text(value.title, 180),
    servings,
    ingredients,
    steps,
    source: {
      type: 'imported',
      name: 'Spoonacular',
      url: sourceUrl,
      attribution: [text(value.creditsText), 'Recipe discovery powered by Spoonacular']
        .filter(Boolean)
        .join(' · '),
      license: 'Spoonacular API · temporary online discovery only',
      licenseUrl: 'https://spoonacular.com/food-api/pricing',
    },
    ...(imageUrl ? { imageUrl } : {}),
    ...(Array.isArray(value.cuisines) && text(value.cuisines[0])
      ? { cuisine: text(value.cuisines[0]) }
      : {}),
    ...(Array.isArray(value.dishTypes) && text(value.dishTypes[0])
      ? { category: text(value.dishTypes[0]) }
      : {}),
  };
  return isRecipe(recipe) ? recipe : null;
}

/** Session-only provider records must never enter saved recipes, meal plans, chat, or backups. */
export function canPersistProviderRecipe(recipe: Recipe): boolean {
  return !recipe.id.startsWith('spoonacular:') && recipe.source.name !== 'Spoonacular';
}

export function parseRecipeProviderStatuses(value: unknown): RecipeProviderStatus[] | null {
  if (!isRecord(value) || !Array.isArray(value.providers) || value.providers.length !== 2)
    return null;
  const results: RecipeProviderStatus[] = [];
  for (const provider of RECIPE_PROVIDER_INFO) {
    const entry = value.providers.find((item) => isRecord(item) && item.id === provider.id);
    if (
      !isRecord(entry) ||
      typeof entry.configured !== 'boolean' ||
      entry.storage !== provider.storage
    )
      return null;
    results.push({ ...provider, configured: entry.configured });
  }
  return results;
}

export function parseRecipeProviderResults(
  value: unknown,
  provider: RecipeProviderId,
): RecipeProviderResults | null {
  const storage = provider === 'spoonacular' ? 'session' : 'personal';
  if (
    !isRecord(value) ||
    value.provider !== provider ||
    value.storage !== storage ||
    !Number.isInteger(value.page) ||
    Number(value.page) < 1 ||
    Number(value.page) > 5000 ||
    typeof value.hasMore !== 'boolean' ||
    !Array.isArray(value.recipes) ||
    value.recipes.length > 10 ||
    !Array.isArray(value.warnings) ||
    value.warnings.length > 12 ||
    !value.warnings.every((item) => text(item, 1000))
  )
    return null;
  if (!value.recipes.every((recipe) => isRecipe(recipe) && recipe.id.startsWith(`${provider}:`)))
    return null;
  if (
    storage === 'session' &&
    (typeof value.expiresAt !== 'number' ||
      !Number.isFinite(value.expiresAt) ||
      value.expiresAt <= Date.now() ||
      value.expiresAt > Date.now() + 60 * 60 * 1000 + 60000)
  )
    return null;
  return {
    provider,
    storage,
    page: Number(value.page),
    hasMore: value.hasMore,
    recipes: value.recipes as Recipe[],
    warnings: value.warnings as string[],
    ...(storage === 'session' ? { expiresAt: Number(value.expiresAt) } : {}),
  };
}
