import { describe, expect, it } from 'vitest';
import type { Recipe } from '../recipes/types';
import {
  ASSISTANT_RECIPE_MODES,
  assistantRecipePool,
  assistantRequestRecipeSources,
} from './conversationSources';

function recipe(id: string, source: Recipe['source'] = { type: 'imported' }): Recipe {
  return {
    id,
    title: id,
    servings: 2,
    ingredients: [{ name: 'Rice', quantity: 1, unit: 'cup' }],
    steps: ['Cook rice.'],
    source,
  };
}

const saved = recipe('saved-import');
const bundled = recipe('wikibooks:rice', { type: 'wikibooks' });
const previous = recipe('publisher:previous');
const attached = recipe('explicit-attachment');
const transient = recipe('spoonacular:123', { type: 'imported', name: 'Spoonacular' });

describe('assistant recipe sources', () => {
  it('defines one clear label and explanation for each persistent source mode', () => {
    expect(ASSISTANT_RECIPE_MODES.map(({ value, label }) => [value, label])).toEqual([
      ['discover', 'Search the web'],
      ['library', 'Choose from the cookbook'],
      ['create', 'Create a recipe'],
    ]);
    expect(ASSISTANT_RECIPE_MODES.every(({ note }) => note.length > 0)).toBe(true);
  });

  it('searches saved recipes and the complete bundled collection only in library mode', () => {
    const collection = Array.from({ length: 30 }, (_, index) =>
      recipe(`wikibooks:${index}`, { type: 'wikibooks' }),
    );
    const savedProvider = recipe('recipeapi:chosen', { type: 'imported', name: 'RecipeAPI.io' });
    const savedInput = [saved, savedProvider];
    const cookbookInput = [...collection, saved];
    expect(assistantRecipePool('library', savedInput, cookbookInput)).toEqual([
      saved,
      savedProvider,
      ...collection,
    ]);
    expect(assistantRecipePool('discover', savedInput, cookbookInput)).toEqual([]);
    expect(assistantRecipePool('create', savedInput, cookbookInput)).toEqual([]);
    expect(savedInput).toEqual([saved, savedProvider]);
    expect(cookbookInput).toEqual([...collection, saved]);
  });

  it('keeps web discussion limited to explicit attachments and previous web cards', () => {
    const sources = assistantRequestRecipeSources('discover', {
      retrievedRecipes: [saved, bundled],
      attachedRecipes: [attached],
      previousRecipes: [previous],
    });
    expect(sources).toEqual({
      candidateRecipes: [attached, previous],
      contextRecipes: [attached, previous],
      discover: true,
    });
    expect(sources.candidateRecipes).not.toContain(saved);
    expect(sources.candidateRecipes).not.toContain(bundled);
  });

  it('keeps library candidates local without enabling live discovery', () => {
    expect(
      assistantRequestRecipeSources('library', {
        retrievedRecipes: [saved, bundled],
        previousRecipes: [previous],
        attachedRecipes: [attached],
      }),
    ).toEqual({
      candidateRecipes: [attached, saved, bundled, previous],
      contextRecipes: [attached, previous],
    });
  });

  it('keeps explicit attachments ahead of automatic library suggestions within the request cap', () => {
    const retrievedRecipes = Array.from({ length: 15 }, (_, index) => recipe(`match:${index}`));
    const sources = assistantRequestRecipeSources('library', {
      retrievedRecipes: [...retrievedRecipes, { ...attached, title: 'Older catalog version' }],
      attachedRecipes: [attached],
      previousRecipes: [previous],
    });
    expect(sources.candidateRecipes).toHaveLength(12);
    expect(sources.candidateRecipes[0]).toBe(attached);
    expect(sources.candidateRecipes.filter(({ id }) => id === attached.id)).toEqual([attached]);
    expect(sources.contextRecipes[0]).toBe(attached);
    expect(retrievedRecipes).toHaveLength(15);
  });

  it('leaves an empty library lookup empty without enabling another source', () => {
    expect(assistantRecipePool('library', [], [])).toEqual([]);
    expect(assistantRequestRecipeSources('library', {})).toEqual({
      candidateRecipes: [],
      contextRecipes: [],
    });
    expect(assistantRequestRecipeSources('discover', {})).toEqual({
      candidateRecipes: [],
      contextRecipes: [],
      discover: true,
    });
  });

  it('creates original recipes without automatic candidate or previous-card context', () => {
    expect(
      assistantRequestRecipeSources('create', {
        retrievedRecipes: [saved, bundled],
        previousRecipes: [previous],
        attachedRecipes: [attached],
      }),
    ).toEqual({ candidateRecipes: [], contextRecipes: [attached] });
    expect(assistantRequestRecipeSources('create', { previousRecipes: [previous] })).toEqual({
      candidateRecipes: [],
      contextRecipes: [],
    });
  });

  it('rejects transient and invalid recipes and deduplicates request context without modifying originals', () => {
    const invalid = { ...saved, id: 'invalid', ingredients: [] };
    expect(assistantRecipePool('library', [transient, invalid, saved], [saved, bundled])).toEqual([
      saved,
      bundled,
    ]);
    for (const mode of ['discover', 'library', 'create'] as const) {
      const sources = assistantRequestRecipeSources(mode, {
        retrievedRecipes: [transient, invalid],
        attachedRecipes: [attached, transient, invalid, attached],
        previousRecipes: [previous, transient, previous],
      });
      expect(sources.contextRecipes).toEqual(mode === 'create' ? [attached] : [attached, previous]);
      expect(sources.candidateRecipes).not.toContain(transient);
      expect(sources.candidateRecipes).not.toContain(invalid);
    }
    expect(attached.source.type).toBe('imported');
  });
});
