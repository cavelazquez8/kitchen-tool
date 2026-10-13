import { describe, expect, it } from 'vitest';
import {
  parseAiReply,
  parseChatRequest,
  parseNutritionExtractRequest,
  parseAiNutritionReply,
  type AiRecipeCandidate,
} from './protocol';

const targets = { caloriesKcal: 2000, proteinGrams: 120, carbsGrams: null, fatGrams: null };
const candidate: AiRecipeCandidate = {
  id: 'wikibooks-chili',
  title: 'Chili',
  servings: 4,
  ingredients: ['1 lb beef', '2 cups beans'],
  missingIngredients: ['beef'],
  source: 'Wikibooks Cookbook',
};
const input = { message: 'Help me choose dinner', inventory: '', candidates: [candidate] };

describe('grounded recommendation protocol', () => {
  it('accepts bounded real candidates and explicitly approved daily targets', () => {
    expect(parseChatRequest({ ...input, nutritionTargets: targets })).toEqual({
      ...input,
      nutritionTargets: targets,
    });
  });

  it('rejects duplicate IDs, empty/oversize candidate sets and malformed nutrition before sending', () => {
    for (const candidates of [
      [],
      Array(13).fill(candidate),
      [candidate, candidate],
      [{ ...candidate, nutrition: { perServing: targets, complete: 'yes' } }],
      [{ ...candidate, ingredients: ['a'.repeat(401)] }],
      Array.from({ length: 12 }, (_, index) => ({
        ...candidate,
        id: String(index),
        ingredients: Array(60).fill('a'.repeat(400)),
      })),
    ])
      expect(parseChatRequest({ ...input, candidates })).toBeNull();
    expect(
      parseChatRequest({ ...input, nutritionTargets: { ...targets, caloriesKcal: -1 } }),
    ).toBeNull();
  });

  it('returns only references to supplied recipes and allows questions without a recommendation', () => {
    const reply = {
      message: 'Would you like chili?',
      recipes: [],
      warnings: [],
      recommendedRecipeIds: [candidate.id],
    };
    expect(parseAiReply(reply, [candidate])).toEqual(reply);
    expect(parseAiReply({ ...reply, recommendedRecipeIds: [] }, [candidate])).not.toBeNull();
    expect(parseAiReply(reply)).toBeNull();
    expect(
      parseAiReply({ ...reply, recommendedRecipeIds: ['invented-recipe'] }, [candidate]),
    ).toBeNull();
    expect(
      parseAiReply({ ...reply, recommendedRecipeIds: [candidate.id, candidate.id] }, [candidate]),
    ).toBeNull();
    expect(parseAiReply({ message: 'Try it', recipes: [], warnings: [] }, [candidate])).toBeNull();
  });

  it('rejects generated replacement recipes in grounded mode', () => {
    expect(
      parseAiReply(
        {
          message: 'Modified chili',
          warnings: [],
          recommendedRecipeIds: [candidate.id],
          recipes: [
            {
              title: 'Invented chili',
              servings: 1,
              ingredients: [{ name: 'beans', quantity: 1, unit: 'cup' }],
              steps: ['Cook.'],
            },
          ],
        },
        [candidate],
      ),
    ).toBeNull();
  });
});

describe('nutrition report extraction protocol', () => {
  it('accepts text or a bounded report image while rejecting links and videos', () => {
    expect(parseNutritionExtractRequest({ text: 'Daily targets: 2000 kcal' })).not.toBeNull();
    expect(
      parseNutritionExtractRequest({ media: { mimeType: 'image/png', data: 'AQID' } }),
    ).not.toBeNull();
    expect(
      parseNutritionExtractRequest({ media: { mimeType: 'video/mp4', data: 'AQID' } }),
    ).toBeNull();
    expect(
      parseNutritionExtractRequest({ text: 'targets', sourceUrl: 'https://example.com' }),
    ).toBeNull();
  });

  it('preserves unknown targets and rejects unsafe values or non-target output', () => {
    const result = {
      targets,
      sourceText: 'Daily targets: 2000 kcal, 120 g protein',
      warnings: ['Carbs and fat not stated.'],
    };
    expect(parseAiNutritionReply(result)).toEqual(result);
    expect(
      parseAiNutritionReply({ ...result, targets: { ...targets, proteinGrams: -1 } }),
    ).toBeNull();
    expect(parseAiNutritionReply({ ...result, targets: { ...targets, invented: 100 } })).toBeNull();
    expect(parseAiNutritionReply({ ...result, recipes: [] })).toBeNull();
  });
});
