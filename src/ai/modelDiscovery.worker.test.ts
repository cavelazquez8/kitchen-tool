// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createWorker, createWorkerState, type Env } from '../../server/src/index';
// Server-only parser/cache tests run through this discovered Vitest entry.
import { googleModel, newModel, pricingPage } from '../../server/src/models.test';

const origin = 'https://mise-kitchen-cv8.expertroot3.chatgpt.site';
const token = 'test_only_' + 'a'.repeat(40);
const env: Env = {
  ALLOWED_ORIGIN: origin,
  GEMINI_API_KEY: 'test-only-key-model-discovery',
  MISE_ACCESS_TOKEN: token,
};
const request = (
  path: string,
  body?: unknown,
  authorization = `Bearer ${token}`,
  requestOrigin = origin,
) =>
  new Request(`https://mise.example.workers.dev${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Origin: requestOrigin,
      Authorization: authorization,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const json = (body: unknown) => new Response(JSON.stringify(body));
const answer = (body: unknown) =>
  json({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(body) }] } }],
  });
const aiReply = { message: 'Fixture answer.', warnings: [], recipes: [] };

describe('private Worker dynamic model discovery', () => {
  it('requires pairing and exact origin before listing models', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const worker = createWorker(fetcher);
    expect((await worker.fetch(request('/models', undefined, ''), env)).status).toBe(401);
    expect(
      (
        await worker.fetch(
          request('/models', undefined, undefined, `${origin}.attacker.example`),
          env,
        )
      ).status,
    ).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('validates discovery and dynamic health queries without outbound calls', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const worker = createWorker(fetcher);
    for (const path of [
      '/models?refresh=0',
      '/models?refresh=1&refresh=1',
      '/models?key=secret',
      '/health?modelReviewed=1',
      '/health?model=gemini-9-flash&modelReviewed=0',
      '/health?model=gemini-9-flash&modelReviewed=1&modelReviewed=1',
    ])
      expect((await worker.fetch(request(path), env)).status).toBe(400);
    expect((await worker.fetch(request('/models', {}), env)).status).toBe(405);
    const unreviewed = await worker.fetch(request(`/health?model=${newModel}`), env);
    expect(unreviewed.status).toBe(403);
    expect((await unreviewed.json()).error.code).toBe('model_unverified');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps built-in health/default generation backward compatible and validates Worker defaults', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(answer(aiReply));
    const worker = createWorker(fetcher);
    expect((await worker.fetch(request('/health'), env)).status).toBe(200);
    expect((await worker.fetch(request('/health?model=gemini-3.8-flash'), env)).status).toBe(200);
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      (await worker.fetch(request('/chat', { message: 'Fixture', inventory: '' }), env)).status,
    ).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      (await worker.fetch(request('/health'), { ...env, GEMINI_MODEL: newModel })).status,
    ).toBe(503);
    expect(
      (
        await worker.fetch(request('/chat', { message: 'Fixture', inventory: '' }), {
          ...env,
          GEMINI_MODEL: newModel,
        })
      ).status,
    ).toBe(503);
  });

  it('returns a bounded catalog, metadata-only health, and an explicit refresh', async () => {
    const state = createWorkerState();
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      String(input).startsWith('https://ai.google.dev')
        ? new Response(pricingPage())
        : json({ models: [googleModel()] }),
    );
    const worker = createWorker(fetcher, () => Date.parse('2026-10-13T12:00:00Z'), state);
    const response = await worker.fetch(request('/models'), env);
    expect(response.status).toBe(200);
    const catalog = await response.json();
    expect(catalog.models[0]).toMatchObject({ id: newModel, freeTier: 'verified' });
    expect(JSON.stringify(catalog)).not.toContain(env.GEMINI_API_KEY);
    const health = await worker.fetch(request(`/health?model=${newModel}&modelReviewed=1`), env);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ model: newModel, modelDiscovery: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(state.minute.count).toBe(0);
    expect(state.day.count).toBe(0);
    await worker.fetch(request('/models?refresh=1'), env);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('uses only reviewed, live, verified models for every generation route', async () => {
    const cases = [
      { path: '/chat', body: { message: 'Fixture', inventory: '' }, reply: aiReply },
      { path: '/extract', body: { text: 'Fixture recipe' }, reply: aiReply },
      {
        path: '/nutrition/extract',
        body: { text: 'Fixture targets' },
        reply: {
          targets: { caloriesKcal: null, proteinGrams: null, carbsGrams: null, fatGrams: null },
          sourceText: 'Fixture targets',
          warnings: [],
        },
      },
      {
        path: '/profile/extract',
        body: { text: 'Fixture report' },
        reply: {
          text: 'Fixture report',
          recordedOn: null,
          targets: { caloriesKcal: null, proteinGrams: null, carbsGrams: null, fatGrams: null },
          warnings: [],
        },
      },
    ];
    for (const entry of cases) {
      const fetcher = vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        if (url.startsWith('https://ai.google.dev')) return new Response(pricingPage());
        if (url.includes(':generateContent')) return answer(entry.reply);
        return json({ models: [googleModel()] });
      });
      const worker = createWorker(fetcher);
      expect(
        (await worker.fetch(request(entry.path, { ...entry.body, model: newModel }), env)).status,
      ).toBe(400);
      expect(fetcher).not.toHaveBeenCalled();
      const response = await worker.fetch(
        request(entry.path, { ...entry.body, model: newModel, modelReviewed: true }),
        env,
      );
      expect(response.status).toBe(200);
      expect(fetcher.mock.calls.at(-1)?.[0]).toBe(
        `https://generativelanguage.googleapis.com/v1beta/models/${newModel}:generateContent`,
      );
      expect(fetcher).toHaveBeenCalledTimes(3);
    }
  });

  it('denies paid, unknown, unavailable and alias models without spending generation allowance', async () => {
    for (const selected of [
      'gemini-9-pro',
      'gemini-9-unknown',
      'gemini-9-unavailable',
      'gemini-9-flash-latest',
    ]) {
      const fetcher = vi.fn<typeof fetch>(async (input) =>
        String(input).startsWith('https://ai.google.dev')
          ? new Response(
              pricingPage() + pricingPage('gemini-9-pro', 'Not available', 'Not available'),
            )
          : json({
              models: [
                googleModel(),
                googleModel('gemini-9-pro'),
                googleModel('gemini-9-unknown'),
                { ...googleModel('gemini-9-flash-latest'), baseModelId: newModel },
              ],
            }),
      );
      const state = createWorkerState();
      const response = await createWorker(fetcher, Date.now, state).fetch(
        request('/chat', {
          message: 'Fixture',
          inventory: '',
          model: selected,
          modelReviewed: true,
        }),
        env,
      );
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe('model_unverified');
      expect(state.day.count).toBe(0);
      expect(fetcher.mock.calls.some(([url]) => String(url).includes(':generateContent'))).toBe(
        false,
      );
    }
  });
});
