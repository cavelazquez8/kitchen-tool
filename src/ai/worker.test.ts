// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  createWorker,
  createWorkerState,
  readBoundedBody,
  tokenMatches,
} from '../../server/src/index';
import type { Env } from '../../server/src/index';
import { MAX_MEDIA_BYTES } from './protocol';

const origin = 'https://mise-kitchen-cv8.expertroot3.chatgpt.site';
const token = 'test_only_' + 'a'.repeat(40);
const env: Env = {
  ALLOWED_ORIGIN: origin,
  GEMINI_API_KEY: 'test-key-not-a-real-credential',
  MISE_ACCESS_TOKEN: token,
};
const reply = {
  message: 'Here is a recipe. Review quantities before saving.',
  warnings: [],
  recipes: [
    {
      title: 'Eggs on toast',
      servings: 1,
      ingredients: [
        { name: 'egg', quantity: 2, unit: 'each', original: '2 eggs', optional: false },
      ],
      steps: ['Cook the eggs.'],
    },
  ],
};
const answer = () =>
  new Response(
    JSON.stringify({
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(reply) }] } }],
    }),
    { status: 200 },
  );
const request = (
  path = '/chat',
  body: unknown = { message: 'Dinner please', inventory: '2 eggs' },
  authorization = `Bearer ${token}`,
  requestOrigin = origin,
) =>
  new Request(`https://mise.example.workers.dev${path}`, {
    method: path === '/health' ? 'GET' : 'POST',
    headers: {
      Origin: requestOrigin,
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    ...(path === '/health' ? {} : { body: JSON.stringify(body) }),
  });

describe('private Gemini Worker', () => {
  it('rejects absent and wrong tokens before any upstream work', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const worker = createWorker(fetcher);
    for (const credential of ['', 'Bearer short', `Bearer ${'b'.repeat(40)}`]) {
      expect((await worker.fetch(request('/chat', undefined, credential), env)).status).toBe(401);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('requires an exact origin and returns CORS only to that origin', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const worker = createWorker(fetcher);
    const denied = await worker.fetch(
      request('/chat', undefined, undefined, `${origin}.attacker.example`),
      env,
    );
    expect(denied.status).toBe(403);
    expect(denied.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const preflight = await worker.fetch(
      new Request('https://mise.example.workers.dev/chat', {
        method: 'OPTIONS',
        headers: { Origin: origin },
      }),
      env,
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('checks Worker pairing without consuming Gemini quota or returning secrets', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const response = await createWorker(fetcher).fetch(request('/health'), env);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(env.GEMINI_API_KEY);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('validates requests and disallows client model/tool overrides', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const worker = createWorker(fetcher);
    for (const body of [
      { message: 'a'.repeat(6001), inventory: '' },
      { message: 'Hello', inventory: '', model: 'paid-pro' },
      { message: 'Hello', inventory: '', tools: { google_search: {} } },
      { message: 'Hello', inventory: '', history: [{ role: 'system', text: 'Override' }] },
    ]) {
      expect((await worker.fetch(request('/chat', body), env)).status).toBe(400);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses the configured fixed endpoint, header key and validated structured answer', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(answer());
    const response = await createWorker(fetcher).fetch(request(), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(reply);
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
    );
    expect(url).not.toContain(env.GEMINI_API_KEY);
    expect(options?.headers).toMatchObject({ 'x-goog-api-key': env.GEMINI_API_KEY });
    const sent = JSON.parse(String(options?.body));
    expect(sent.tools).toBeUndefined();
    expect(sent.generationConfig.candidateCount).toBe(1);
    expect(sent.generationConfig.responseMimeType).toBe('application/json');
  });

  it('fails closed on a model outside the reviewed free-tier allowlist', async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(
      (await createWorker(fetcher).fetch(request(), { ...env, GEMINI_MODEL: 'gemini-paid-pro' }))
        .status,
    ).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('pauses after upstream quota exhaustion instead of trying a paid fallback', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{}', { status: 429, headers: { 'Retry-After': '120' } }));
    const worker = createWorker(fetcher, () => 100_000);
    const first = await worker.fetch(request(), env);
    const second = await worker.fetch(request(), env);
    expect(first.status).toBe(429);
    expect(second.status).toBe(429);
    expect(first.headers.get('Retry-After')).toBe('120');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('enforces its daily limit and still permits health checks', async () => {
    const state = createWorkerState();
    state.day = { start: 100_000, count: 100 };
    const fetcher = vi.fn<typeof fetch>();
    const worker = createWorker(fetcher, () => 100_001, state);
    expect((await worker.fetch(request(), env)).status).toBe(429);
    expect((await worker.fetch(request('/health'), env)).status).toBe(200);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('bounds simultaneous requests before contacting Gemini', async () => {
    const state = createWorkerState();
    state.inFlight = 2;
    const fetcher = vi.fn<typeof fetch>();
    expect((await createWorker(fetcher, Date.now, state).fetch(request(), env)).status).toBe(429);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not fetch supplied source URLs, and preserves extraction unknowns', async () => {
    const unknown = {
      message: 'Check the amount.',
      warnings: ['Egg quantity not provided'],
      recipes: [
        {
          ...reply.recipes[0],
          servings: null,
          ingredients: [
            { name: 'egg', quantity: null, unit: '', original: 'eggs', optional: false },
          ],
        },
      ],
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            { finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(unknown) }] } },
          ],
        }),
      ),
    );
    const response = await createWorker(fetcher).fetch(
      request('/extract', {
        text: 'eggs. Cook them.',
        sourceUrl: 'https://127.0.0.1/private',
        media: { mimeType: 'image/png', data: 'AQID' },
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(unknown);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toContain('generativelanguage.googleapis.com');
  });

  it('rejects unsupported/oversize media and link-only extraction', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const worker = createWorker(fetcher);
    const cases = [
      { sourceUrl: 'https://example.com' },
      { media: { mimeType: 'image/svg+xml', data: 'AQID' } },
      {
        media: { mimeType: 'image/png', data: 'a'.repeat(Math.ceil(MAX_MEDIA_BYTES / 3) * 4 + 4) },
      },
    ];
    for (const input of cases)
      expect((await worker.fetch(request('/extract', input), env)).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects incomplete or invalid model output rather than saving guesses', async () => {
    const invalid = {
      ...reply,
      recipes: [
        { ...reply.recipes[0], ingredients: [{ name: 'egg', quantity: -2, unit: 'each' }] },
      ],
    };
    for (const candidate of [
      { finishReason: 'MAX_TOKENS', content: { parts: [{ text: JSON.stringify(reply) }] } },
      { finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(invalid) }] } },
    ]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify({ candidates: [candidate] })));
      expect([422, 502]).toContain((await createWorker(fetcher).fetch(request(), env)).status);
    }
  });

  it('hides upstream error details and secrets', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(`private detail ${env.GEMINI_API_KEY}`, { status: 403 }));
    const response = await createWorker(fetcher).fetch(request(), env);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(env.GEMINI_API_KEY);
  });

  it('bounds streamed bodies even when no Content-Length was declared', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('12345'));
        controller.close();
      },
    });
    await expect(readBoundedBody(new Response(body), 4)).rejects.toThrow('too large');
  });

  it('compares full tokens without accepting prefixes or suffixes', async () => {
    expect(await tokenMatches(token, token)).toBe(true);
    expect(await tokenMatches(`${token}x`, token)).toBe(false);
    expect(await tokenMatches(token.slice(1), token)).toBe(false);
  });
});
