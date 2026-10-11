import type { InventoryState } from '../domain/types';
import { canonicalIngredientName } from './matching';
import { parseMeasure } from './parse';
import { isRecipe, type Recipe } from './types';

const API = 'https://www.themealdb.com/api/json/v1/1/';
const CACHE_MS = 30 * 60 * 1000;
const cache = new Map<string, { expires: number; value: unknown }>();
const pending = new Map<string, Promise<unknown>>();
export type RecipeFetcher = typeof fetch;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
function url(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    return ['https:', 'http:'].includes(parsed.protocol) ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

/** Full details have measures/instructions; ingredient filter results do not. */
export function mealToRecipe(value: unknown): Recipe | null {
  if (!record(value)) return null;
  const ingredients: Recipe['ingredients'] = [];
  for (let index = 1; index <= 20; index++) {
    const name = text(value[`strIngredient${index}`]);
    if (!name) continue;
    const measure = text(value[`strMeasure${index}`]);
    const parsed = parseMeasure(measure);
    ingredients.push({
      name,
      quantity: parsed.quantity,
      unit: parsed.unit,
      original: [measure, name].filter(Boolean).join(' '),
    });
  }
  const instructions = text(value.strInstructions);
  // Keep intact paragraphs and remove only standalone numbered step headings.
  const steps = instructions
    .split(/\r?\n+/)
    .map((step) => step.trim())
    .filter((step) => step && !/^(?:step\s+)?\d+[.):]?$/i.test(step));
  const id = text(value.idMeal);
  const imageUrl = url(value.strMealThumb);
  const sourceUrl =
    url(value.strSource) ??
    (id ? `https://www.themealdb.com/meal/${encodeURIComponent(id)}` : undefined);
  const recipe: Recipe = {
    id: `themealdb:${id}`,
    title: text(value.strMeal),
    servings: null,
    ingredients,
    steps,
    source: { type: 'themealdb', name: 'TheMealDB', ...(sourceUrl ? { url: sourceUrl } : {}) },
    ...(imageUrl ? { imageUrl } : {}),
    ...(text(value.strCategory) ? { category: text(value.strCategory) } : {}),
    ...(text(value.strArea) ? { cuisine: text(value.strArea) } : {}),
  };
  return id && isRecipe(recipe) ? recipe : null;
}

async function request(endpoint: string, fetcher: RecipeFetcher): Promise<unknown> {
  const cached = cache.get(endpoint);
  if (cached && cached.expires > Date.now()) return cached.value;
  const active = pending.get(endpoint);
  if (active) return active;
  const operation = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetcher(`${API}${endpoint}`, { signal: controller.signal });
      if (!response.ok) throw new Error('Recipe library is unavailable. Try again shortly.');
      const value: unknown = await response.json();
      if (!record(value) || !(value.meals === null || Array.isArray(value.meals)))
        throw new Error('The recipe library returned an unexpected response.');
      if (cache.size >= 100) cache.delete(cache.keys().next().value!);
      cache.set(endpoint, { expires: Date.now() + CACHE_MS, value });
      return value;
    } finally {
      clearTimeout(timer);
    }
  })();
  pending.set(endpoint, operation);
  try {
    return await operation;
  } finally {
    pending.delete(endpoint);
  }
}
function meals(value: unknown): unknown[] {
  return record(value) && Array.isArray(value.meals) ? value.meals : [];
}

export async function searchRecipes(
  query: string,
  fetcher: RecipeFetcher = fetch,
): Promise<Recipe[]> {
  const term = query.trim().slice(0, 100);
  if (!term) return [];
  return meals(await request(`search.php?s=${encodeURIComponent(term)}`, fetcher))
    .map(mealToRecipe)
    .filter((recipe): recipe is Recipe => recipe !== null)
    .slice(0, 30);
}
export async function fetchRecipe(
  id: string,
  fetcher: RecipeFetcher = fetch,
): Promise<Recipe | null> {
  const key = id.replace(/^themealdb:/, '');
  if (!/^\d+$/.test(key)) throw new Error('Choose a valid recipe.');
  return mealToRecipe(meals(await request(`lookup.php?i=${key}`, fetcher))[0]);
}

/** Small, user-driven discovery, never full-database enumeration or premium endpoint bypass. */
export async function discoverRecipes(
  inventory: InventoryState,
  fetcher: RecipeFetcher = fetch,
): Promise<Recipe[]> {
  const active = new Set(
    inventory.batches
      .filter((batch) => batch.quantity !== 0 && batch.stapleStatus !== 'empty')
      .map((batch) => batch.productId),
  );
  const names = [
    ...new Set(
      inventory.products
        .filter((product) => active.has(product.id) && !product.isStaple)
        .map((product) => canonicalIngredientName(product.ingredientName ?? product.name)),
    ),
  ].slice(0, 3);
  if (names.length === 0) {
    // A small useful starter search; no random polling or alphabet crawl.
    const results = await Promise.allSettled(
      ['chicken', 'pasta', 'rice'].map((query) => searchRecipes(query, fetcher)),
    );
    const recipes = results.flatMap((result) =>
      result.status === 'fulfilled' ? result.value : [],
    );
    if (recipes.length === 0 && results.every((result) => result.status === 'rejected'))
      throw new Error('Recipe library is unavailable. Your saved recipes are still available.');
    return [...new Map(recipes.map((recipe) => [recipe.id, recipe])).values()].slice(0, 12);
  }
  const filters = await Promise.allSettled(
    names.map((name) =>
      request(`filter.php?i=${encodeURIComponent(name.replace(/ /g, '_'))}`, fetcher),
    ),
  );
  const ids = [
    ...new Set(
      filters.flatMap((result) =>
        result.status === 'fulfilled'
          ? meals(result.value)
              .map((meal) => (record(meal) ? text(meal.idMeal) : ''))
              .filter(Boolean)
              .slice(0, 4)
          : [],
      ),
    ),
  ].slice(0, 12);
  const details = await Promise.allSettled(ids.map((id) => fetchRecipe(id, fetcher)));
  const recipes = details.flatMap((result) =>
    result.status === 'fulfilled' && result.value ? [result.value] : [],
  );
  if (
    recipes.length === 0 &&
    (filters.every((result) => result.status === 'rejected') ||
      (details.length > 0 && details.every((result) => result.status === 'rejected')))
  )
    throw new Error('Recipe library is unavailable. Your saved recipes are still available.');
  return recipes;
}

/** Clears public recipe responses only; inventory and personal recipes are never sent to this API. */
export function clearRecipeLibraryCache(): void {
  cache.clear();
}
