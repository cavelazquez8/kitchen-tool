import type { AssistantSession } from '../domain/types';
import { canPersistProviderRecipe } from '../recipes/providers';
import { isRecipe, type Recipe } from '../recipes/types';
import { conversationRecipes } from './conversation';

export type AssistantRecipeMode = AssistantSession['mode'];

export const ASSISTANT_RECIPE_MODES = [
  {
    value: 'discover',
    label: 'Search the web',
    note: 'Find publisher recipes online.',
  },
  {
    value: 'library',
    label: 'Choose from the cookbook',
    note: 'Use your saved recipes and built-in collection, without live API searches.',
  },
  {
    value: 'create',
    label: 'Create a recipe',
    note: 'Ask Gemini for an original recipe using your shared context.',
  },
] as const satisfies readonly { value: AssistantRecipeMode; label: string; note: string }[];

/** The complete local search pool; request-sized limits apply after retrieval. */
export function assistantRecipePool(
  mode: AssistantRecipeMode,
  savedRecipes: readonly Recipe[],
  bundledRecipes: readonly Recipe[],
): Recipe[] {
  if (mode !== 'library') return [];
  const seen = new Set<string>();
  return [...savedRecipes, ...bundledRecipes].filter((recipe) => {
    if (!isRecipe(recipe) || !canPersistProviderRecipe(recipe) || seen.has(recipe.id)) return false;
    seen.add(recipe.id);
    return true;
  });
}

interface RecipeDiscussion {
  /** Locally ranked matches from assistantRecipePool; ignored outside library mode. */
  retrievedRecipes?: readonly Recipe[];
  /** Only previous cards whose recorded recipesMode matches this mode; legacy cards are display-only. */
  previousRecipes?: readonly Recipe[];
  attachedRecipes?: readonly Recipe[];
}

export interface AssistantRequestRecipeSources {
  candidateRecipes: Recipe[];
  contextRecipes: Recipe[];
  discover?: true;
}

/**
 * An attachment is an explicit discussion choice, not permission to search its provider.
 * An empty library result must be handled locally rather than sent as generation mode.
 */
export function assistantRequestRecipeSources(
  mode: AssistantRecipeMode,
  { retrievedRecipes = [], previousRecipes = [], attachedRecipes = [] }: RecipeDiscussion,
): AssistantRequestRecipeSources {
  if (mode === 'create')
    return {
      candidateRecipes: [],
      contextRecipes: conversationRecipes(attachedRecipes),
    };
  return {
    candidateRecipes: conversationRecipes(
      mode === 'library'
        ? [...attachedRecipes, ...retrievedRecipes, ...previousRecipes]
        : [...attachedRecipes, ...previousRecipes],
    ),
    contextRecipes: conversationRecipes([...attachedRecipes, ...previousRecipes]),
    ...(mode === 'discover' ? { discover: true as const } : {}),
  };
}
