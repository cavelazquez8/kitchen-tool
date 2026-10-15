import { describe, expect, it } from 'vitest';
import { isRecipe, type Recipe } from '../recipes/types';
import {
  boundedChatHistory,
  boundedInventoryContext,
  normalizeAiRecipe,
  recipeContext,
} from './context';
import { parseChatRequest } from './protocol';
import type { AiMessage, AiRecipeDraft } from './protocol';

const draft: AiRecipeDraft = {
  title: ' Egg toast ',
  servings: 2,
  ingredients: [
    { name: ' egg ', quantity: 2, unit: ' each ', original: '', optional: false },
    { name: 'butter', quantity: null, unit: '', original: ' butter to taste ', optional: true },
  ],
  steps: [' Cook the egg. ', 'Serve on toast.'],
};
const recipe = normalizeAiRecipe(draft, 'recipe:one', { type: 'ai', name: 'Gemini' });

describe('bounded AI context', () => {
  it('makes optional empty AI metadata saveable without losing amounts or source attribution', () => {
    expect(isRecipe(recipe)).toBe(true);
    expect(recipe.ingredients[0]).toEqual({
      name: 'egg',
      quantity: 2,
      unit: 'each',
      optional: false,
    });
    expect(recipe.ingredients[1]).toMatchObject({
      name: 'butter',
      quantity: null,
      original: 'butter to taste',
      optional: true,
    });
    expect(recipe.source).toEqual({ type: 'ai', name: 'Gemini' });
    expect(draft.ingredients[0].original).toBe('');
    expect(draft.title).toBe(' Egg toast ');
  });

  it('keeps the newest twelve valid turns in chronological order', () => {
    const history: AiMessage[] = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      text: `turn ${index}`,
    }));
    history.push({ role: 'assistant', text: '  ' });
    const result = boundedChatHistory(history);
    expect(result).toHaveLength(12);
    expect(result[0].text).toBe('turn 8');
    expect(result[11].text).toBe('turn 19');
    expect(history[20].text).toBe('  ');
  });
  it('keeps publisher metadata and original source for imports and makes declared nutrition available to follow-ups', () => {
    const publisherDraft: AiRecipeDraft = {
      ...draft,
      source: {
        type: 'imported',
        url: 'https://example.com/original',
        name: 'Recipe publisher',
        attribution: 'Ada Cook · Recipe publisher',
      },
      imageUrl: 'https://example.com/soup.jpg',
      author: 'Ada Cook',
      totalMinutes: 25,
      publisherNutrition: { servingSize: '1 bowl', calories: '230 kcal', protein: '12 g' },
    };
    const imported = normalizeAiRecipe(publisherDraft, 'publisher:one', {
      type: 'imported',
      url: 'https://example.com/redirect',
    });
    expect(isRecipe(imported)).toBe(true);
    expect(imported.source.url).toBe('https://example.com/original');
    expect(imported.imageUrl).toBe(publisherDraft.imageUrl);
    const context = recipeContext(imported);
    expect(context).toContain('Original source URL: https://example.com/original');
    expect(context).toContain('Total time: 25 minutes');
    expect(context).toContain('230 kcal');
    expect(context).toContain('1 bowl');
    expect(context).toContain('do not assume a serving basis');
    expect(
      normalizeAiRecipe(publisherDraft, 'ai:one', { type: 'ai', name: 'Gemini' }).source.type,
    ).toBe('ai');
  });

  it('bounds long valid answers so the next question remains valid for the API', () => {
    const history: AiMessage[] = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      text: `turn ${index}: ` + 'a'.repeat(16000),
    }));
    const result = boundedChatHistory(history);
    expect(result.length).toBeLessThanOrEqual(12);
    expect(result.at(-1)?.text).toContain('turn 11:');
    expect(result.every((item) => item.text.length <= 6000)).toBe(true);
    expect(result.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(24000);
    expect(
      parseChatRequest({ message: 'Can I use this pan?', inventory: '', history: result }),
    ).not.toBeNull();
  });

  it('keeps recipe quantities, unknowns, optional ingredients and cooking steps explicit', () => {
    const context = recipeContext(recipe);
    expect(context).toContain('Original servings: 2');
    expect(context).toContain('2 each: egg');
    expect(context).toContain('Quantity unknown: butter (optional)');
    expect(context).toContain('original: butter to taste');
    expect(context).toContain('2. Serve on toast.');
    expect(context).not.toContain('shortened');
  });

  it('bounds a large otherwise-valid recipe and explicitly identifies omitted instructions', () => {
    const large: Recipe = {
      ...recipe,
      ingredients: Array.from({ length: 60 }, (_, index) => ({
        name: `ingredient ${index}`,
        quantity: null,
        unit: '',
        original: 'a'.repeat(400),
      })),
      steps: Array.from({ length: 60 }, (_, index) => `Step ${index}: ` + 'b'.repeat(2990)),
    };
    const context = recipeContext(large);
    expect(context.length).toBeLessThanOrEqual(12000);
    expect(context).toContain('Ingredients shortened');
    expect(context).toContain('Steps shortened');
    expect(context).toContain('Quantity unknown: ingredient 0');
    expect(
      parseChatRequest({ message: 'Explain the recipe', inventory: '', recipe: context }),
    ).not.toBeNull();
  });

  it('shortens inventory at a line boundary and warns against assuming absent items', () => {
    const markdown =
      '# Inventory\n' +
      Array.from(
        { length: 1000 },
        (_, index) => `- Item ${index}: 2 packages; expiry unknown`,
      ).join('\n');
    const result = boundedInventoryContext(markdown);
    expect(result.length).toBeLessThanOrEqual(24000);
    expect(result).toContain('Items not shown may still be in the kitchen');
    expect(result.split('\n\n[Inventory')[0]).toMatch(/expiry unknown$/);
    expect(boundedInventoryContext('Eggs: 2')).toBe('Eggs: 2');
  });

  it('fits all bounded sections into their individual request validation limits', () => {
    const history = boundedChatHistory(
      Array.from({ length: 12 }, () => ({ role: 'assistant' as const, text: 'a'.repeat(16000) })),
    );
    expect(
      parseChatRequest({
        message: 'Question',
        inventory: boundedInventoryContext('a'.repeat(30000)),
        recipe: recipeContext(recipe),
        history,
      }),
    ).not.toBeNull();
  });
});
