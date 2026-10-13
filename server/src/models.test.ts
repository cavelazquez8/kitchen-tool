// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  authorizeDiscoveredModel,
  createModelDiscoveryState,
  discoverGeminiModels,
  parseModelPricing,
} from './models';

export const newModel = 'gemini-9-flash';
export const googleModel = (id = newModel) => ({
  name: `models/${id}`,
  displayName: 'Gemini fixture model',
  description: 'Test-only model metadata.',
  inputTokenLimit: 100000,
  outputTokenLimit: 8000,
  supportedGenerationMethods: ['generateContent'],
});
export const pricingTable = (
  input = 'Free of charge',
  output = 'Free of charge',
  freeColumnFirst = true,
) => `
  <table class="pricing-table"><thead><tr><th></th><th>${freeColumnFirst ? 'Free Tier' : 'Paid Tier'}</th><th>${freeColumnFirst ? 'Paid Tier' : 'Free Tier'}</th></tr></thead><tbody>
  <tr><td>Input price (text, image, video)</td><td>${freeColumnFirst ? input : '$1.00'}</td><td>${freeColumnFirst ? '$1.00' : input}</td></tr>
  <tr><td>Output price (including thinking tokens)</td><td>${freeColumnFirst ? output : '$2.00'}</td><td>${freeColumnFirst ? '$2.00' : output}</td></tr>
  </tbody></table>`;
export const pricingPage = (id = newModel, input = 'Free of charge', output = 'Free of charge') =>
  `<h2>${id}</h2><em><code>${id}</code></em><section><h3>Standard</h3>${pricingTable(input, output)}</section>`;
const apiKey = 'test-only-key-models';
const clock = () => Date.parse('2026-10-13T12:00:00Z');
const json = (body: unknown) => new Response(JSON.stringify(body));

describe('official model pricing verification', () => {
  it('reads only exact model IDs and the Standard Free Tier column', () => {
    const page =
      pricingPage() +
      `<h2>Paid fixture</h2><code>gemini-9-pro</code><h3>Standard</h3>${pricingTable('Not available', 'Not available')}<h3>Batch</h3>${pricingTable()}`;
    expect(parseModelPricing(page).get(newModel)).toBe('verified');
    expect(parseModelPricing(page).get('gemini-9-pro')).toBe('unavailable');
    expect(
      parseModelPricing(
        `<h2>model</h2><code>${newModel}</code><h3>Standard</h3>${pricingTable('Not available', 'Not available', false)}`,
      ).get(newModel),
    ).toBe('unavailable');
  });

  it('never inherits pricing from a family, alias, or base-model prefix', () => {
    const prices = parseModelPricing(pricingPage());
    expect(prices.has('gemini-9-flash-preview')).toBe(false);
    expect(prices.has('gemini-9-flash-latest')).toBe(false);
  });

  it('fails closed for layout changes, missing rows, conditional free values and duplicate sections', () => {
    const mutations = [
      pricingPage().replace('Free Tier', 'Free plan'),
      pricingPage().replace('<thead>', '<div>').replace('</thead>', '</div>'),
      pricingPage().replace('Output price (including thinking tokens)', 'Other service'),
      pricingPage().replace('Standard', 'Batch'),
      pricingPage().replace('<td>Free of charge</td>', '<td>Free of charge<sup>*</sup></td>'),
      pricingPage().replace('<td>Free of charge</td>', '<td colspan="2">Free of charge</td>'),
      pricingPage() + pricingPage(),
    ];
    for (const html of mutations)
      expect(parseModelPricing(html).get(newModel)).not.toBe('verified');
  });

  it('ignores markup embedded in scripts and comments and rejects oversized pages', () => {
    expect(parseModelPricing(`<script>${pricingPage()}</script><!--${pricingPage()}-->`).size).toBe(
      0,
    );
    expect(() => parseModelPricing('x'.repeat(1024 * 1024 + 1))).toThrow();
  });
});

describe('Gemini discovery metadata', () => {
  it('paginates live models, excludes specialists, and sends Google keys only to the API', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, options) => {
      const url = new URL(String(input));
      expect(options?.redirect).toBe('manual');
      expect(options).not.toHaveProperty('cache');
      if (url.hostname === 'ai.google.dev') {
        expect(options?.headers).not.toHaveProperty('x-goog-api-key');
        expect(String(input)).not.toContain(apiKey);
        return new Response(pricingPage());
      }
      expect(options?.headers).toMatchObject({ 'x-goog-api-key': apiKey });
      expect(url.searchParams.get('pageSize')).toBe('200');
      return json(
        url.searchParams.has('pageToken')
          ? { models: [googleModel('gemini-9-pro')] }
          : {
              models: [
                googleModel(),
                googleModel('gemini-9-flash-tts'),
                {
                  ...googleModel('gemini-9-embedding'),
                  supportedGenerationMethods: ['embedContent'],
                },
              ],
              nextPageToken: 'second page',
            },
      );
    });
    const catalog = await discoverGeminiModels(apiKey, createModelDiscoveryState(), fetcher, clock);
    expect(catalog.models.map((model) => model.id)).toEqual([newModel, 'gemini-9-pro']);
    expect(catalog.models[0].freeTier).toBe('verified');
    expect(catalog.models[1].freeTier).toBe('unknown');
    expect(catalog.checkedAt).toBe('2026-10-13T12:00:00.000Z');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(catalog)).not.toContain(apiKey);
  });

  it('caches by key, refreshes explicitly, and deduplicates in-flight work', async () => {
    const state = createModelDiscoveryState();
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      String(input).startsWith('https://ai.google.dev')
        ? new Response(pricingPage())
        : json({ models: [googleModel()] }),
    );
    const [first, parallel] = await Promise.all([
      discoverGeminiModels(apiKey, state, fetcher, clock),
      discoverGeminiModels(apiKey, state, fetcher, clock),
    ]);
    expect(first).toEqual(parallel);
    await discoverGeminiModels(apiKey, state, fetcher, clock);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await discoverGeminiModels('other-test-only-key', state, fetcher, clock);
    expect(fetcher).toHaveBeenCalledTimes(4);
    await discoverGeminiModels(apiKey, state, fetcher, clock, true);
    expect(fetcher).toHaveBeenCalledTimes(6);
    await discoverGeminiModels(apiKey, state, fetcher, () => clock() + 60 * 60 * 1000 + 1);
    expect(fetcher).toHaveBeenCalledTimes(8);
  });

  it('requires review and exact current free pricing before authorization', async () => {
    const state = createModelDiscoveryState();
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      String(input).startsWith('https://ai.google.dev')
        ? new Response(
            pricingPage() + pricingPage('gemini-9-pro', 'Not available', 'Not available'),
          )
        : json({
            models: [
              googleModel(),
              googleModel('gemini-9-pro'),
              { ...googleModel('gemini-9-flash-latest'), baseModelId: newModel },
            ],
          }),
    );
    await expect(
      authorizeDiscoveredModel(newModel, undefined, apiKey, state, fetcher, clock),
    ).rejects.toMatchObject({ code: 'model_unverified' });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      authorizeDiscoveredModel(newModel, true, apiKey, state, fetcher, clock),
    ).resolves.toBeUndefined();
    for (const denied of ['gemini-9-pro', 'gemini-9-flash-latest', 'gemini-not-live'])
      await expect(
        authorizeDiscoveredModel(denied, true, apiKey, state, fetcher, clock),
      ).rejects.toMatchObject({ status: 403, code: 'model_unverified' });
  });

  it('removes prior verified authorization after failed pricing refresh', async () => {
    const state = createModelDiscoveryState();
    let broken = false;
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      String(input).startsWith('https://ai.google.dev')
        ? broken
          ? new Response(null, { status: 503 })
          : new Response(pricingPage())
        : json({ models: [googleModel()] }),
    );
    await authorizeDiscoveredModel(newModel, true, apiKey, state, fetcher, clock);
    broken = true;
    const updated = await discoverGeminiModels(apiKey, state, fetcher, clock, true);
    expect(updated.models[0].freeTier).toBe('unknown');
    expect(updated.warnings).toHaveLength(1);
    await expect(
      authorizeDiscoveredModel(newModel, true, apiKey, state, fetcher, clock),
    ).rejects.toMatchObject({ code: 'model_unverified' });
  });

  it('does not follow redirects and rejects malformed, repeated or excessive pages', async () => {
    for (const body of [
      {},
      { models: [], nextPageToken: '' },
      { models: [], nextPageToken: 'repeat' },
      { models: Array.from({ length: 201 }, () => googleModel()) },
    ]) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(body));
      await expect(
        discoverGeminiModels(apiKey, createModelDiscoveryState(), fetcher, clock),
      ).rejects.toMatchObject({ code: 'models_response' });
    }
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { Location: 'https://untrusted.example' } }),
      );
    await expect(
      discoverGeminiModels(apiKey, createModelDiscoveryState(), fetcher, clock),
    ).rejects.toMatchObject({ code: 'models_upstream' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('limits discovery requests independently from generation', async () => {
    const state = createModelDiscoveryState();
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      String(input).startsWith('https://ai.google.dev')
        ? new Response(pricingPage())
        : json({ models: [googleModel()] }),
    );
    for (let index = 0; index < 10; index++)
      await discoverGeminiModels(apiKey, state, fetcher, clock);
    await expect(discoverGeminiModels(apiKey, state, fetcher, clock)).rejects.toMatchObject({
      status: 429,
      code: 'models_rate_limit',
    });
    await expect(
      discoverGeminiModels(apiKey, state, fetcher, () => clock() + 60_000),
    ).resolves.toBeDefined();
  });
});
