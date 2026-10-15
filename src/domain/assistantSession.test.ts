import { describe, expect, it } from 'vitest';
import { isAssistantSession, isInventoryState, type InventoryState } from './types';
import { buildInventoryBackup } from '../lib/backup';
import { createLocalRepository } from '../lib/localRepository';
import type { Recipe } from '../recipes/types';

const recipe: Recipe = {
  id: 'source-recipe',
  title: 'Example source recipe',
  servings: 4,
  ingredients: [{ name: 'rice', quantity: 2, unit: 'cup' }],
  steps: ['Cook the rice.'],
  source: { type: 'imported', url: 'https://example.com/rice', name: 'Example publisher' },
};
const session = {
  recipes: [recipe],
  attachedRecipes: [recipe],
  draft: 'Can this be reheated?',
  mode: 'discover' as const,
};

describe('persistent assistant recipe context', () => {
  it('keeps recommendations, attachments, and the draft in local storage and transferable backups', async () => {
    localStorage.clear();
    const repository = createLocalRepository();
    await repository.update((state) => ({ ...state, assistantSession: session }));
    expect(createLocalRepository().getSnapshot().state.assistantSession).toEqual(session);
    const backup = buildInventoryBackup(repository.getSnapshot().state).inventory;
    expect(backup.assistantSession).toEqual(session);
    expect(backup.assistantSession?.recipes[0]).not.toBe(recipe);
    expect(backup.assistantSession?.attachedRecipes[0].ingredients).not.toBe(recipe.ingredients);
  });

  it('rejects damaged or unbounded cards while old inventories remain valid', () => {
    const old: InventoryState = { products: [], batches: [], tools: [] };
    expect(isInventoryState(old)).toBe(true);
    expect(isInventoryState({ ...old, assistantSession: session })).toBe(true);
    expect(isAssistantSession({ ...session, recipes: [recipe, recipe] })).toBe(false);
    expect(isAssistantSession({ ...session, recipes: [{ ...recipe, ingredients: [] }] })).toBe(
      false,
    );
    expect(isAssistantSession({ ...session, draft: 'x'.repeat(6001) })).toBe(false);
    expect(isAssistantSession({ ...session, mode: 'unrecognized' })).toBe(false);
  });

  it('uses backup allowlists to exclude future connection fields nested in session records', () => {
    const withPrivateFields = {
      products: [],
      batches: [],
      tools: [],
      assistantSession: {
        ...session,
        token: 'secret',
        recipes: [{ ...recipe, token: 'recipe-secret' }],
      },
    };
    const serialized = JSON.stringify(buildInventoryBackup(withPrivateFields));
    expect(serialized).not.toContain('secret');
    expect(serialized).toContain(recipe.title);
  });
});
