import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  forgetModelPreferences,
  isModelCatalogFresh,
  readModelPreferences,
  reviewGeminiModel,
  saveModelCatalog,
} from './modelPreferences';
import { GEMINI_PRICING_URL, type GeminiModelCatalog } from './models';

const key = 'mise.gemini.models.v1';
const worker = 'https://mise.example.workers.dev';
const otherWorker = 'https://other.example.workers.dev';
const now = Date.parse('2026-10-13T12:00:00.000Z');

function catalog(checkedAt = new Date(now).toISOString()): GeminiModelCatalog {
  return {
    models: [
      {
        id: 'gemini-4-flash',
        name: 'Gemini 4 Flash',
        description: 'Example model used only by tests.',
        inputTokenLimit: 1000,
        outputTokenLimit: 100,
        freeTier: 'unknown',
      },
    ],
    checkedAt,
    pricingUrl: GEMINI_PRICING_URL,
    warnings: [],
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('local Gemini model preferences', () => {
  it('starts empty and scopes the catalog and explicit reviews to the normalized Worker URL', () => {
    expect(readModelPreferences(worker)).toEqual({ catalog: null, reviewedIds: [] });
    saveModelCatalog('  MISE.example.workers.dev/ ', catalog());
    reviewGeminiModel(worker, 'gemini-4-flash');
    expect(readModelPreferences(`${worker}/`)).toEqual({
      catalog: catalog(),
      reviewedIds: ['gemini-4-flash'],
    });
    expect(readModelPreferences(otherWorker)).toEqual({ catalog: null, reviewedIds: [] });
    expect(readModelPreferences(`${worker}/?token=secret`)).toEqual({
      catalog: null,
      reviewedIds: [],
    });
  });

  it('refreshes availability without enabling newly discovered models or discarding past reviews', () => {
    saveModelCatalog(worker, catalog());
    reviewGeminiModel(worker, 'gemini-4-flash');
    const refreshed: GeminiModelCatalog = {
      ...catalog(),
      models: [{ ...catalog().models[0], id: 'gemini-5-flash' }],
    };
    saveModelCatalog(worker, refreshed);
    expect(readModelPreferences(worker)).toEqual({
      catalog: refreshed,
      reviewedIds: ['gemini-4-flash'],
    });
    expect(readModelPreferences(worker).reviewedIds).not.toContain('gemini-5-flash');
  });

  it('replaces the isolated ledger when a different Worker saves its model list', () => {
    saveModelCatalog(worker, catalog());
    reviewGeminiModel(worker, 'gemini-4-flash');
    saveModelCatalog(otherWorker, catalog());
    expect(readModelPreferences(worker)).toEqual({ catalog: null, reviewedIds: [] });
    expect(readModelPreferences(otherWorker)).toEqual({ catalog: catalog(), reviewedIds: [] });
  });

  it('deduplicates valid explicit reviews and excludes tokens and unrelated inventory data', () => {
    localStorage.setItem('kitchen-wrapper.inventory.v1', 'private kitchen');
    localStorage.setItem('mise.gemini.connection.v1', 'private pairing token');
    reviewGeminiModel(worker, 'gemini-4-flash');
    reviewGeminiModel(worker, 'gemini-4-flash');
    expect(readModelPreferences(worker)).toEqual({
      catalog: null,
      reviewedIds: ['gemini-4-flash'],
    });
    const stored = JSON.parse(localStorage.getItem(key)!);
    expect(Object.keys(stored).sort()).toEqual(['catalog', 'reviewedIds', 'url']);
    expect(localStorage.getItem(key)).not.toContain('private');
    forgetModelPreferences();
    expect(readModelPreferences(worker)).toEqual({ catalog: null, reviewedIds: [] });
    expect(localStorage.getItem('kitchen-wrapper.inventory.v1')).toBe('private kitchen');
    expect(localStorage.getItem('mise.gemini.connection.v1')).toBe('private pairing token');
  });

  it.each([
    'not JSON',
    'null',
    '[]',
    JSON.stringify({
      url: worker,
      catalog: null,
      reviewedIds: ['gemini-4-flash'],
      token: 'secret',
    }),
    JSON.stringify({
      url: worker,
      catalog: null,
      reviewedIds: ['gemini-4-flash', 'gemini-4-flash'],
    }),
    JSON.stringify({ url: worker, catalog: null, reviewedIds: ['models/gemini-4-flash'] }),
    JSON.stringify({ url: worker, catalog: null, reviewedIds: ['../gemini-4-flash'] }),
    JSON.stringify({ url: worker, catalog: null, reviewedIds: ['not-a-gemini-model'] }),
    JSON.stringify({ url: worker, catalog: null, reviewedIds: [true] }),
    JSON.stringify({ url: worker, catalog: {}, reviewedIds: [] }),
    JSON.stringify({
      url: worker,
      catalog: { ...catalog(), pricingUrl: 'https://example.test' },
      reviewedIds: [],
    }),
  ])('ignores invalid stored preferences without deleting the original record (%s)', (stored) => {
    localStorage.setItem(key, stored);
    expect(readModelPreferences(worker)).toEqual({ catalog: null, reviewedIds: [] });
    expect(localStorage.getItem(key)).toBe(stored);
  });

  it('bounds reviewed IDs, rejects invalid IDs and does not overwrite valid data on failed writes', () => {
    const ids = Array.from({ length: 200 }, (_, index) => `gemini-test-${index}`);
    localStorage.setItem(key, JSON.stringify({ url: worker, catalog: null, reviewedIds: ids }));
    const original = localStorage.getItem(key);
    expect(readModelPreferences(worker).reviewedIds).toEqual(ids);
    expect(() => reviewGeminiModel(worker, 'gemini-new-model')).toThrow('Too many');
    expect(() => reviewGeminiModel(worker, '../gemini-model')).toThrow('valid Gemini model');
    expect(() => saveModelCatalog(`${worker}/?key=secret`, catalog())).toThrow(
      'valid Worker address',
    );
    expect(localStorage.getItem(key)).toBe(original);
    localStorage.setItem(
      key,
      JSON.stringify({ url: worker, catalog: null, reviewedIds: [...ids, 'gemini-extra'] }),
    );
    expect(readModelPreferences(worker)).toEqual({ catalog: null, reviewedIds: [] });
  });

  it('propagates storage failure so the interface cannot claim an unsaved review or refresh', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage is full.', 'QuotaExceededError');
    });
    expect(() => reviewGeminiModel(worker, 'gemini-4-flash')).toThrow('Storage is full');
    expect(() => saveModelCatalog(worker, catalog())).toThrow('Storage is full');
    expect(readModelPreferences(worker)).toEqual({ catalog: null, reviewedIds: [] });
  });

  it('rejects malformed catalog records before storing them', () => {
    const invalid = { ...catalog(), models: [{ ...catalog().models[0], id: 'text-bison' }] };
    expect(() => saveModelCatalog(worker, invalid)).toThrow('could not be saved');
    expect(localStorage.getItem(key)).toBeNull();
  });
});

describe('Gemini catalog freshness', () => {
  it('refreshes after one hour and allows only five seconds of local clock drift', () => {
    expect(isModelCatalogFresh(catalog(), now)).toBe(true);
    expect(isModelCatalogFresh(catalog(new Date(now - 3_599_999).toISOString()), now)).toBe(true);
    expect(isModelCatalogFresh(catalog(new Date(now - 3_600_000).toISOString()), now)).toBe(false);
    expect(isModelCatalogFresh(catalog(new Date(now + 5000).toISOString()), now)).toBe(true);
    expect(isModelCatalogFresh(catalog(new Date(now + 5001).toISOString()), now)).toBe(false);
  });

  it('treats unusable dates or time values as stale', () => {
    expect(isModelCatalogFresh(catalog('invalid'), now)).toBe(false);
    expect(isModelCatalogFresh(catalog(), Number.NaN)).toBe(false);
    expect(isModelCatalogFresh(catalog(), Number.POSITIVE_INFINITY)).toBe(false);
  });
});
