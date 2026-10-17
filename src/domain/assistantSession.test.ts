import { describe, expect, it } from 'vitest';
import {
  MAX_ASSISTANT_INVENTORY_PRODUCTS,
  MAX_ASSISTANT_PRODUCT_ID_LENGTH,
  isAssistantSession,
  isInventoryState,
  type InventoryState,
} from './types';
import { updateAssistantSession } from '../ai/conversation';
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
  it('preserves optional card provenance through storage and backups without reclassifying legacy cards', async () => {
    for (const recipesMode of ['discover', 'library', 'create'] as const) {
      localStorage.clear();
      const repository = createLocalRepository();
      const marked = { ...session, recipesMode };
      await repository.update((state) => ({ ...state, assistantSession: marked }));
      expect(createLocalRepository().getSnapshot().state.assistantSession).toEqual(marked);
      const backup = buildInventoryBackup(repository.getSnapshot().state);
      expect(backup.inventory.assistantSession?.recipesMode).toBe(recipesMode);
      await repository.replace(backup.inventory);
      expect(createLocalRepository().getSnapshot().state.assistantSession).toEqual(marked);
    }
    const legacy = buildInventoryBackup({
      products: [],
      batches: [],
      tools: [],
      assistantSession: session,
    });
    expect(legacy.inventory.assistantSession).toEqual(session);
    expect(legacy.inventory.assistantSession).not.toHaveProperty('recipesMode');
  });

  it('rejects malformed card provenance but allows visible cards from a previously selected source', () => {
    expect(isAssistantSession({ ...session, mode: 'library', recipesMode: 'discover' })).toBe(true);
    for (const recipesMode of ['web', 'unknown', null, 42, false, {}, ['discover']]) {
      expect(isAssistantSession({ ...session, recipesMode })).toBe(false);
      expect(
        isInventoryState({
          products: [],
          batches: [],
          tools: [],
          assistantSession: { ...session, recipesMode },
        }),
      ).toBe(false);
    }
  });

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

  it('persists each inventory-sharing mode, including no selected ingredients, through backup restoration', async () => {
    for (const inventoryContext of [
      { mode: 'all' as const, productIds: [] },
      { mode: 'none' as const, productIds: [] },
      { mode: 'selected' as const, productIds: [] },
      { mode: 'selected' as const, productIds: ['carrots', 'deleted-product'] },
      { mode: 'all' as const, productIds: [], preferredProductIds: ['carrots'] },
      { mode: 'none' as const, productIds: ['carrots'], preferredProductIds: ['carrots'] },
      { mode: 'selected' as const, productIds: ['carrots'], preferredProductIds: ['carrots'] },
    ]) {
      localStorage.clear();
      const repository = createLocalRepository();
      const updatedSession = { ...session, inventoryContext };
      await repository.update((state) => ({ ...state, assistantSession: updatedSession }));
      expect(createLocalRepository().getSnapshot().state.assistantSession).toEqual(updatedSession);
      const backup = buildInventoryBackup(repository.getSnapshot().state);
      await repository.replace(backup.inventory);
      expect(createLocalRepository().getSnapshot().state.assistantSession).toEqual(updatedSession);
      expect(backup.inventory.assistantSession?.inventoryContext).not.toBe(inventoryContext);
      expect(backup.inventory.assistantSession?.inventoryContext?.productIds).not.toBe(
        inventoryContext.productIds,
      );
      if (inventoryContext.preferredProductIds) {
        const copiedPriorities =
          backup.inventory.assistantSession?.inventoryContext?.preferredProductIds;
        expect(copiedPriorities).not.toBe(inventoryContext.preferredProductIds);
        copiedPriorities!.push('new-product');
        expect(inventoryContext.preferredProductIds).toEqual(['carrots']);
      }
      expect(
        updateAssistantSession(repository.getSnapshot().state, { draft: 'Follow up' })
          .assistantSession?.inventoryContext,
      ).toEqual(inventoryContext);
    }
  });

  it('rejects malformed sharing preferences instead of silently restoring full inventory', () => {
    for (const inventoryContext of [
      null,
      {},
      { mode: 'everything', productIds: [] },
      { mode: 'all', productIds: null },
      { mode: 'selected', productIds: ['carrots', 'carrots'] },
      { mode: 'selected', productIds: [''] },
      { mode: 'selected', productIds: [' '] },
      { mode: 'selected', productIds: [42] },
      { mode: 'selected', productIds: ['x'.repeat(MAX_ASSISTANT_PRODUCT_ID_LENGTH + 1)] },
      {
        mode: 'selected',
        productIds: Array.from(
          { length: MAX_ASSISTANT_INVENTORY_PRODUCTS + 1 },
          (_, i) => `id-${i}`,
        ),
      },
    ]) {
      expect(isAssistantSession({ ...session, inventoryContext })).toBe(false);
      expect(
        isInventoryState({
          products: [],
          batches: [],
          tools: [],
          assistantSession: { ...session, inventoryContext },
        }),
      ).toBe(false);
    }
  });

  it('does not export unknown fields within inventory-sharing preferences', () => {
    const state = {
      products: [],
      batches: [],
      tools: [],
      assistantSession: {
        ...session,
        inventoryContext: {
          mode: 'selected' as const,
          productIds: ['carrots'],
          token: 'PRIVATE_CONTEXT_TOKEN',
        },
      },
    };
    const backup = buildInventoryBackup(state);
    expect(backup.inventory.assistantSession?.inventoryContext).toEqual({
      mode: 'selected',
      productIds: ['carrots'],
    });
    expect(JSON.stringify(backup)).not.toContain('PRIVATE_CONTEXT_TOKEN');
    backup.inventory.assistantSession!.inventoryContext!.productIds.push('new-product');
    expect(state.assistantSession.inventoryContext.productIds).toEqual(['carrots']);
  });
});

describe('persisted ingredient priority validation', () => {
  it('rejects invalid or out-of-scope preferred IDs instead of restoring invalid context', () => {
    for (const preferredProductIds of [
      null,
      'carrots',
      {},
      [''],
      [' '],
      [42],
      ['carrots', 'carrots'],
      ['private'],
      ['x'.repeat(MAX_ASSISTANT_PRODUCT_ID_LENGTH + 1)],
      Array.from({ length: MAX_ASSISTANT_INVENTORY_PRODUCTS + 1 }, (_, index) => `id-${index}`),
    ]) {
      const inventoryContext = { mode: 'selected', productIds: ['carrots'], preferredProductIds };
      expect(isAssistantSession({ ...session, inventoryContext })).toBe(false);
      expect(
        isInventoryState({
          products: [],
          batches: [],
          tools: [],
          assistantSession: { ...session, inventoryContext },
        }),
      ).toBe(false);
    }
    expect(
      isAssistantSession({
        ...session,
        inventoryContext: { mode: 'selected', productIds: [], preferredProductIds: [] },
      }),
    ).toBe(true);
  });
});
