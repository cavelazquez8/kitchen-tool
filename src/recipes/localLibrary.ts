import { canonicalIngredientName } from './matching';
import { isRecipe, type Recipe } from './types';

const COLLECTION_URL = '/data/wikibooks-recipes.json';
const MAX_COLLECTION_BYTES = 20 * 1024 * 1024;
const MAX_RECIPES = 10_000;
const LOAD_TIMEOUT_MS = 20_000;
const LOAD_ERROR =
  'Mise’s recipe collection could not be loaded. Try again; your saved recipes are still available.';
let cachedRecipes: Recipe[] | null = null;
let pendingRecipes: Promise<Recipe[]> | null = null;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readCollection(response: Response): Promise<unknown> {
  const length = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(length) && length > MAX_COLLECTION_BYTES) throw new Error(LOAD_ERROR);
  if (!response.body) throw new Error(LOAD_ERROR);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let json = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_COLLECTION_BYTES) {
        await reader.cancel();
        throw new Error(LOAD_ERROR);
      }
      json += decoder.decode(value, { stream: true });
    }
    return JSON.parse(json + decoder.decode()) as unknown;
  } finally {
    reader.releaseLock();
  }
}

/** Load the deployed collection once, without contacting a third-party recipe service. */
export async function loadLocalRecipes(fetcher: typeof fetch = fetch): Promise<Recipe[]> {
  if (cachedRecipes) return cachedRecipes;
  if (pendingRecipes) return pendingRecipes;
  // One page's cancellation must not abort the shared collection needed by another caller.
  const operation = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LOAD_TIMEOUT_MS);
    try {
      const response = await fetcher(COLLECTION_URL, {
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-cache',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(LOAD_ERROR);
      const payload = await readCollection(response);
      if (
        !record(payload) ||
        payload.version !== 1 ||
        !Array.isArray(payload.recipes) ||
        payload.recipes.length === 0 ||
        payload.recipes.length > MAX_RECIPES ||
        !payload.recipes.every(isRecipe)
      )
        throw new Error(LOAD_ERROR);
      cachedRecipes = uniqueRecipes(payload.recipes);
      return cachedRecipes;
    } catch {
      throw new Error(LOAD_ERROR);
    } finally {
      clearTimeout(timeout);
    }
  })();
  pendingRecipes = operation;
  try {
    return await operation;
  } finally {
    pendingRecipes = null;
  }
}

/** Keep the first version of each ID, letting callers deliberately prefer personal edits. */
export function uniqueRecipes(recipes: readonly Recipe[]): Recipe[] {
  const found = new Map<string, Recipe>();
  for (const recipe of recipes) {
    if (!found.has(recipe.id)) found.set(recipe.id, recipe);
  }
  return [...found.values()];
}

export interface LocalRecipeFilters {
  category?: string;
  cuisine?: string;
}

/** Search names and ingredients locally; inventory, searches, and saved recipes stay on-device. */
export function searchLocalRecipes(
  recipes: readonly Recipe[],
  query: string,
  filters: LocalRecipeFilters = {},
): Recipe[] {
  const tokens = canonicalIngredientName(query).split(' ').filter(Boolean);
  return recipes.filter((recipe) => {
    if (filters.category && recipe.category !== filters.category) return false;
    if (filters.cuisine && recipe.cuisine !== filters.cuisine) return false;
    if (!tokens.length) return true;
    const searchable = [recipe.title, ...recipe.ingredients.map((ingredient) => ingredient.name)]
      .map(canonicalIngredientName)
      .join(' ');
    return tokens.every((token) => searchable.includes(canonicalIngredientName(token)));
  });
}

export function recipeFacets(recipes: readonly Recipe[]): {
  categories: string[];
  cuisines: string[];
} {
  const values = (key: 'category' | 'cuisine') =>
    [
      ...new Set(recipes.map((recipe) => recipe[key]).filter((value): value is string => !!value)),
    ].sort((a, b) => a.localeCompare(b));
  return { categories: values('category'), cuisines: values('cuisine') };
}

/** Reset only the public collection cache; useful when retrying a refreshed deployment. */
export function clearLocalRecipeCache(): void {
  cachedRecipes = null;
}
