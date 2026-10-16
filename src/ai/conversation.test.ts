import { describe, expect, it } from 'vitest';
import { createEmptyInventory } from '../domain/types';
import type { Recipe } from '../recipes/types';
import { conversationRecipes, emptyAssistantSession, updateAssistantSession } from './conversation';

const recipe: Recipe = {
  id: 'publisher:one',
  title: 'Carrot soup',
  servings: 2,
  ingredients: [{ name: 'Carrots', quantity: 200, unit: 'g', original: '200 g carrots' }],
  steps: ['Simmer the carrots.'],
  source: { type: 'imported', name: 'Publisher', url: 'https://example.com/soup' },
};

describe('persistent assistant context', () => {
  it('retains proven card sources through unrelated edits and leaves legacy provenance unknown', () => {
    const legacy = updateAssistantSession(createEmptyInventory(), { recipes: [recipe] });
    const legacyDraft = updateAssistantSession(legacy, { draft: 'Follow-up' });
    expect(legacyDraft.assistantSession?.recipes).toEqual([recipe]);
    expect(legacyDraft.assistantSession).not.toHaveProperty('recipesMode');
    const proven = updateAssistantSession(legacyDraft, {
      recipes: [recipe],
      recipesMode: 'discover',
    });
    const changedDraft = updateAssistantSession(proven, { draft: 'Another question' });
    expect(changedDraft.assistantSession?.recipesMode).toBe('discover');
    const changedSource = updateAssistantSession(changedDraft, {
      mode: 'library',
      recipes: [],
      recipesMode: 'library',
    });
    expect(changedSource.assistantSession).toMatchObject({
      mode: 'library',
      recipesMode: 'library',
      recipes: [],
    });
    expect(changedSource.assistantSession?.draft).toBe('Another question');
    expect(proven.assistantSession?.recipes).toEqual([recipe]);
  });

  it('preserves the chosen inventory scope through drafts and assistant replies', () => {
    const inventory = createEmptyInventory();
    const preference = { mode: 'selected' as const, productIds: [] };
    const selected = updateAssistantSession(inventory, { inventoryContext: preference });
    const replied = updateAssistantSession(selected, { recipes: [recipe], draft: 'Next question' });
    expect(replied.assistantSession?.inventoryContext).toEqual(preference);
    expect(replied.assistantSession?.inventoryContext).not.toBe(preference);
    expect(replied.assistantSession?.inventoryContext?.productIds).not.toBe(preference.productIds);
    expect(
      updateAssistantSession(replied, { inventoryContext: { mode: 'none', productIds: [] } })
        .assistantSession?.inventoryContext,
    ).toEqual({ mode: 'none', productIds: [] });
  });
  it('excludes temporary provider recipes, duplicates and invalid records without changing originals', () => {
    const temporary: Recipe = {
      ...recipe,
      id: 'spoonacular:1',
      source: { type: 'imported', name: 'Spoonacular' },
    };
    const invalid: Recipe = { ...recipe, id: 'invalid', ingredients: [] };
    expect(conversationRecipes([recipe, temporary, recipe, invalid])).toEqual([recipe]);
    expect(recipe.ingredients[0].original).toBe('200 g carrots');
  });

  it('merges independent changes with the latest kitchen and keeps the conversation bounded', () => {
    const inventory = { ...createEmptyInventory(), tools: [{ id: 'tool', name: 'Dutch oven' }] };
    const first = updateAssistantSession(inventory, { recipes: [recipe], mode: 'library' });
    const afterDraft = updateAssistantSession(
      { ...first, assistantSession: { ...first.assistantSession!, bodyScanIds: ['scan'] } },
      { draft: 'x'.repeat(7000) },
    );
    expect(afterDraft.assistantSession?.draft).toHaveLength(6000);
    expect(afterDraft.assistantSession?.recipes).toEqual([recipe]);
    expect(afterDraft.assistantSession?.mode).toBe('library');
    expect(afterDraft.assistantSession?.bodyScanIds).toEqual(['scan']);
    expect(afterDraft.tools).toEqual(inventory.tools);
    expect(inventory).not.toHaveProperty('assistantSession');
    expect(
      conversationRecipes(
        Array.from({ length: 20 }, (_, index) => ({ ...recipe, id: String(index) })),
      ),
    ).toHaveLength(12);
    expect(emptyAssistantSession()).toEqual({
      recipes: [],
      attachedRecipes: [],
      draft: '',
      mode: 'discover',
    });
  });
});
