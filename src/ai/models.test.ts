import { describe, expect, it } from 'vitest';
import { GEMINI_PRICING_URL, parseGeminiModelCatalog } from './models';

const model = {
  id: 'gemini-4.0-flash',
  name: 'Gemini 4.0 Flash',
  description: 'A newly available general-purpose model.',
  inputTokenLimit: 1_048_576,
  outputTokenLimit: 65_536,
  freeTier: 'verified',
};
const catalog = {
  models: [model],
  checkedAt: '2026-10-13T12:00:00.000Z',
  pricingUrl: GEMINI_PRICING_URL,
  warnings: [],
};

describe('Gemini model catalog validation', () => {
  it('preserves live model descriptions, free status and documented source without approving a selection', () => {
    expect(parseGeminiModelCatalog(catalog)).toEqual(catalog);
    expect(
      parseGeminiModelCatalog({ ...catalog, checkedAt: '2026-10-13T12:00:00Z', models: [] }),
    ).not.toBeNull();
    for (const freeTier of ['unknown', 'unavailable'])
      expect(
        parseGeminiModelCatalog({
          ...catalog,
          models: [{ ...model, freeTier, inputTokenLimit: null }],
        }),
      ).not.toBeNull();
  });

  it('rejects duplicates, arbitrary URLs, undocumented prices and malformed catalog metadata', () => {
    for (const invalid of [
      { ...catalog, models: [model, model] },
      {
        ...catalog,
        models: Array.from({ length: 201 }, (_, index) => ({
          ...model,
          id: `gemini-new-${index}`,
        })),
      },
      { ...catalog, models: [{ ...model, id: 'models/gemini-4.0-flash' }] },
      { ...catalog, models: [{ ...model, id: 'gemini-new?key=secret' }] },
      { ...catalog, models: [{ ...model, freeTier: 'free' }] },
      { ...catalog, models: [{ ...model, inputTokenLimit: -1 }] },
      { ...catalog, models: [{ ...model, outputTokenLimit: 1.5 }] },
      { ...catalog, models: [{ ...model, outputTokenLimit: undefined }] },
      { ...catalog, models: [{ ...model, description: 'x'.repeat(2001) }] },
      { ...catalog, models: [{ ...model, approved: true }] },
      { ...catalog, checkedAt: '2026-02-30T12:00:00.000Z' },
      { ...catalog, checkedAt: 'yesterday' },
      { ...catalog, pricingUrl: 'https://example.com/pricing' },
      { ...catalog, warnings: ['x'.repeat(1001)] },
      { ...catalog, warnings: Array(21).fill('Warning') },
      { ...catalog, modelReviewed: true },
    ])
      expect(parseGeminiModelCatalog(invalid)).toBeNull();
  });
});
