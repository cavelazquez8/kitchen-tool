import { describe, expect, it } from 'vitest';
import {
  parseAiReply,
  parseChatRequest,
  parseNutritionExtractRequest,
  parseAiNutritionReply,
  parseBodyScanExtractRequest,
  parseAiBodyScanReply,
  parseExtractRequest,
  MAX_BODY_SCAN_BYTES,
  MAX_CHAT_REQUEST_BYTES,
  type AiRecipeCandidate,
  isGeminiModel,
  isGeminiModelId,
  isSupportedModelSelection,
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

describe('reviewed Gemini model selection', () => {
  it('keeps legacy model compatibility while requiring explicit approval for newly discovered IDs', () => {
    expect(isGeminiModel('gemini-3.8-flash')).toBe(true);
    expect(isGeminiModel('gemini-4.0-flash')).toBe(false);
    expect(isGeminiModelId('gemini-4.0-flash')).toBe(true);
    expect(isSupportedModelSelection(undefined, undefined)).toBe(true);
    expect(isSupportedModelSelection('gemini-3.8-flash', undefined)).toBe(true);
    expect(isSupportedModelSelection('gemini-3.8-flash', true)).toBe(true);
    expect(isSupportedModelSelection('gemini-4.0-flash', undefined)).toBe(false);
    expect(isSupportedModelSelection('gemini-4.0-flash', true)).toBe(true);
  });

  it('rejects unsafe IDs and mismatched approvals before either Worker endpoint receives them', () => {
    const parsers = [
      (selection: object) => parseChatRequest({ message: 'Dinner', inventory: '', ...selection }),
      (selection: object) => parseExtractRequest({ text: 'Recipe', ...selection }),
      (selection: object) => parseNutritionExtractRequest({ text: 'Daily targets', ...selection }),
      (selection: object) => parseBodyScanExtractRequest({ text: 'Report', ...selection }),
    ];
    const selection = { model: 'gemini-4.0-flash', modelReviewed: true };
    for (const parser of parsers) {
      expect(parser(selection)).toMatchObject(selection);
      for (const invalid of [
        { model: selection.model },
        { model: selection.model, modelReviewed: false },
        { modelReviewed: true },
        { model: 'models/gemini-4.0-flash', modelReviewed: true },
        { model: 'gemini-new?api=key', modelReviewed: true },
        { model: 'gemini-new/../../other', modelReviewed: true },
        { model: `gemini-${'a'.repeat(100)}`, modelReviewed: true },
        { model: 'GEMINI-4.0-flash', modelReviewed: true },
        { model: 'gemini--new', modelReviewed: true },
        { model: 'gemini-new', modelReviewed: 'true' },
      ])
        expect(parser(invalid)).toBeNull();
    }
  });
});

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

describe('profile report protocol', () => {
  it('accepts complete Unicode context above the former 128 KB Worker limit', () => {
    const context = {
      message: 'Help choose dinner',
      inventory: '食'.repeat(24000),
      profile: '体'.repeat(24000),
      history: Array.from({ length: 5 }, () => ({ role: 'user', text: '菜'.repeat(6000) })),
    };
    const bytes = new TextEncoder().encode(JSON.stringify(context)).byteLength;
    expect(bytes).toBeGreaterThan(128 * 1024);
    expect(bytes).toBeLessThanOrEqual(MAX_CHAT_REQUEST_BYTES);
    expect(parseChatRequest(context)).toEqual(context);
  });

  it('rejects aggregate escaped data above the shared cap even when each field fits', () => {
    const context = {
      message: '\u0000'.repeat(6000),
      inventory: '\u0000'.repeat(24000),
      profile: '\u0000'.repeat(24000),
      recipe: '\u0000'.repeat(12000),
      history: Array.from({ length: 5 }, () => ({ role: 'user', text: '\u0000'.repeat(6000) })),
    };
    expect(new TextEncoder().encode(JSON.stringify(context)).byteLength).toBeGreaterThan(
      MAX_CHAT_REQUEST_BYTES,
    );
    expect(parseChatRequest(context)).toBeNull();
  });

  it('keeps selected reviewed reports separate from daily targets and recipe attachments', () => {
    const context = {
      ...input,
      profile: 'Body scan, 2026-10-01: BMR 1650 kcal; body fat 20%.',
      recipe: 'Original chili recipe',
      nutritionTargets: targets,
      model: 'gemini-3.8-flash',
    };
    expect(parseChatRequest(context)).toEqual(context);
    expect(parseChatRequest({ ...context, profile: 'a'.repeat(24001) })).toBeNull();
    expect(parseChatRequest({ ...context, model: 'paid-model' })).toBeNull();
  });

  it('accepts native PDF report content independently of recipe extraction limits', () => {
    const exactLimit = 'A'.repeat(Math.ceil(MAX_BODY_SCAN_BYTES / 3) * 4 - 2) + '==';
    const report = {
      media: { mimeType: 'application/pdf', data: exactLimit },
      model: 'gemini-3.1-flash-lite',
    };
    expect(parseBodyScanExtractRequest(report)).toEqual(report);
    expect(parseExtractRequest(report)).toBeNull();
    expect(
      parseBodyScanExtractRequest({
        media: { mimeType: 'application/pdf', data: 'A'.repeat(exactLimit.length) },
      }),
    ).toBeNull();
  });

  it('rejects unbounded text, videos, links, malformed data and unsupported model overrides', () => {
    for (const report of [
      {},
      { text: ' ' },
      { text: 'a'.repeat(24001) },
      { text: 'Report', sourceUrl: 'https://example.com/report.pdf' },
      { media: { mimeType: 'video/mp4', data: 'AQID' } },
      { media: { mimeType: 'application/pdf', data: 'AQID!' } },
      { media: { mimeType: 'image/svg+xml', data: 'AQID' } },
      { text: 'Report', model: 'paid-model' },
    ])
      expect(parseBodyScanExtractRequest(report)).toBeNull();
  });

  it('preserves measurements, unknown goals and scan dates while rejecting unreadable outputs', () => {
    const result = {
      text: 'Scan date: February 29, 2024\nBMR: 1650 kcal\nBody fat: 20%',
      recordedOn: '2024-02-29',
      targets: { caloriesKcal: null, proteinGrams: null, carbsGrams: null, fatGrams: null },
      warnings: ['No explicitly recommended daily intake targets are stated.'],
    };
    expect(parseAiBodyScanReply(result)).toEqual(result);
    expect(parseAiBodyScanReply({ ...result, recordedOn: null })).not.toBeNull();
    for (const invalid of [
      { ...result, recordedOn: '2026-02-29' },
      { ...result, recordedOn: '10/01/2026' },
      { ...result, text: '' },
      { ...result, text: 'a'.repeat(24001) },
      { ...result, targets: { ...targets, caloriesKcal: -1 } },
      { ...result, recipes: [] },
      { ...result, recordedOn: undefined },
    ])
      expect(parseAiBodyScanReply(invalid)).toBeNull();
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
