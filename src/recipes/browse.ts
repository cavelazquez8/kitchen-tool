import type { InventoryState } from '../domain/types';
import { searchLocalRecipes } from './localLibrary';
import { rankRecipes, type RecipeMatch } from './matching';
import type { Recipe } from './types';

export type BrowseSource = 'library' | 'themealdb' | 'recipeapi' | 'spoonacular';
export type BrowseFilter = 'all' | 'ready' | 'close' | 'saved';
export type BrowseOrder = 'kitchen' | 'browse' | 'fewest-short';
export type RecipeCollection = 'all' | 'saved' | 'imported' | 'manual' | 'ai';

export interface BrowseOptions {
  query?: string;
  category?: string;
  cuisine?: string;
  filter?: BrowseFilter;
  collection?: RecipeCollection;
  order?: BrowseOrder;
  prioritizeExpiration?: boolean;
  savedIds?: readonly string[];
}

/** Apply the same presentation filters to built-in, saved, and online search results. */
export function browseRecipes(
  recipes: readonly Recipe[],
  inventory: InventoryState,
  options: BrowseOptions = {},
): RecipeMatch[] {
  const savedIds = options.savedIds ?? inventory.recipes?.map((recipe) => recipe.id) ?? [];
  const collection = selectRecipeCollection(
    recipes,
    options.filter === 'saved' && (!options.collection || options.collection === 'all')
      ? 'saved'
      : (options.collection ?? 'all'),
    savedIds,
  );
  const filtered = searchLocalRecipes(collection, options.query ?? '', {
    category: options.category,
    cuisine: options.cuisine,
  });
  const matches = rankRecipes(filtered, inventory, {
    prioritizeExpiration: options.prioritizeExpiration,
  }).filter(
    (match) =>
      (options.filter !== 'ready' || match.status === 'ready') &&
      (options.filter !== 'close' || match.missingCount <= 2),
  );

  if (options.order === 'browse')
    matches.sort(
      (a, b) =>
        (options.prioritizeExpiration ? b.useSoonCount - a.useSoonCount : 0) ||
        a.recipe.title.localeCompare(b.recipe.title),
    );
  if (options.order === 'fewest-short')
    matches.sort(
      (a, b) =>
        a.missingCount - b.missingCount ||
        a.uncertainCount - b.uncertainCount ||
        (options.prioritizeExpiration ? b.useSoonCount - a.useSoonCount : 0) ||
        b.matchedCount - a.matchedCount ||
        a.recipe.title.localeCompare(b.recipe.title) ||
        a.recipe.id.localeCompare(b.recipe.id),
    );
  return matches;
}

export function recipeCollectionLabel(collection: RecipeCollection): string {
  return {
    all: 'All recipes',
    saved: 'Saved recipes',
    imported: 'Imported recipes',
    manual: 'Your own recipes',
    ai: 'AI-created recipes',
  }[collection];
}

/** Personal collections contain saved records; API discovery is not a personal import. */
export function selectRecipeCollection(
  recipes: readonly Recipe[],
  collection: RecipeCollection,
  savedIds: readonly string[],
): Recipe[] {
  if (collection === 'all') return [...recipes];
  const saved = new Set(savedIds);
  return recipes.filter((recipe) => {
    if (!saved.has(recipe.id)) return false;
    if (collection === 'saved') return true;
    if (collection === 'imported') {
      const sourceName = recipe.source.name?.trim().toLowerCase();
      return (
        recipe.source.type === 'imported' &&
        !/^(?:recipeapi|spoonacular):/i.test(recipe.id) &&
        sourceName !== 'recipeapi.io' &&
        sourceName !== 'spoonacular'
      );
    }
    return recipe.source.type === collection;
  });
}

/** Later lists replace earlier versions while keeping their original position. Pass saved edits last. */
export function dedupeRecipes(...lists: readonly (readonly Recipe[])[]): Recipe[] {
  const recipes = new Map<string, Recipe>();
  for (const list of lists) {
    for (const recipe of list) recipes.set(recipe.id, recipe);
  }
  return [...recipes.values()];
}

export function recipeSourceName(source: BrowseSource): string {
  return {
    library: 'Your cookbook',
    themealdb: 'TheMealDB',
    recipeapi: 'RecipeAPI.io',
    spoonacular: 'Spoonacular',
  }[source];
}

function normalizedRequestText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** A fetch identity, independent of display filters and inventory quantities. No credentials enter it. */
export function requestScopeKey(
  source: BrowseSource,
  query: string,
  ingredients: readonly string[] = [],
): string {
  const names = [...new Set(ingredients.map(normalizedRequestText).filter(Boolean))].sort();
  return JSON.stringify([source, normalizedRequestText(query), names]);
}
