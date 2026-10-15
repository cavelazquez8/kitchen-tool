import type { AssistantSession, InventoryState } from '../domain/types';
import { canPersistProviderRecipe } from '../recipes/providers';
import { isRecipe, type Recipe } from '../recipes/types';

interface AssistantActivity {
  busy: boolean;
  prompt: string;
  error?: string;
}
let activity: AssistantActivity = { busy: false, prompt: '' };
const activityListeners = new Set<() => void>();

export function subscribeAssistantActivity(listener: () => void): () => void {
  activityListeners.add(listener);
  return () => {
    activityListeners.delete(listener);
  };
}

export function getAssistantActivity(): AssistantActivity {
  return activity;
}

/** A browser tab keeps one request alive while its assistant view is unmounted. */
export function beginAssistantRequest(prompt: string): ((error?: string) => void) | null {
  if (activity.busy) return null;
  activity = { busy: true, prompt };
  activityListeners.forEach((listener) => listener());
  let ended = false;
  return (error) => {
    if (ended) return;
    ended = true;
    activity = { busy: false, prompt: '', ...(error ? { error } : {}) };
    activityListeners.forEach((listener) => listener());
  };
}

export function emptyAssistantSession(): AssistantSession {
  return { recipes: [], attachedRecipes: [], draft: '', mode: 'discover' };
}

/** Recommendations are complete original recipes, not an AI summary of their ingredients. */
export function conversationRecipes(recipes: readonly Recipe[]): Recipe[] {
  const seen = new Set<string>();
  return recipes
    .filter((recipe) => {
      if (!isRecipe(recipe) || !canPersistProviderRecipe(recipe) || seen.has(recipe.id))
        return false;
      seen.add(recipe.id);
      return true;
    })
    .slice(0, 12);
}

/** Merge only session fields so a reply can never overwrite a concurrent inventory edit. */
export function updateAssistantSession(
  state: InventoryState,
  patch: Partial<AssistantSession>,
): InventoryState {
  const session = { ...emptyAssistantSession(), ...state.assistantSession, ...patch };
  return {
    ...state,
    assistantSession: {
      recipes: conversationRecipes(session.recipes),
      attachedRecipes: conversationRecipes(session.attachedRecipes),
      draft: session.draft.slice(0, 6000),
      mode: session.mode,
      ...(session.bodyScanIds ? { bodyScanIds: [...session.bodyScanIds] } : {}),
    },
  };
}
