import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkGeminiConnection,
  clearGeminiConnection,
  extractGeminiRecipe,
  fileToGeminiMedia,
  importGeminiRecipeUrl,
  generateGeminiAccessToken,
  normalizeGeminiConnection,
  readGeminiConnection,
  saveGeminiConnection,
  sendGeminiChat,
} from './client';
import { MAX_MEDIA_BYTES } from './protocol';

const connection = { url: 'https://mise.example.workers.dev', token: 'a'.repeat(43) };
const reply = { message: 'Try scrambled eggs.', recipes: [], warnings: [] };

beforeEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('Gemini browser adapter', () => {
  it('stores only the personal connection and can disconnect without touching inventory', () => {
    localStorage.setItem('mise.inventory', 'private inventory');
    saveGeminiConnection(connection);
    expect(readGeminiConnection()).toEqual(connection);
    clearGeminiConnection();
    expect(readGeminiConnection()).toBeNull();
    expect(localStorage.getItem('mise.inventory')).toBe('private inventory');
  });

  it('rejects insecure destinations, unexpected paths and Gemini keys in token settings', () => {
    for (const url of [
      'http://mise.example.workers.dev',
      'https://attacker.example',
      'https://mise.example.workers.dev/chat',
      'https://mise.example.workers.dev/?key=secret',
      'https://user:secret@mise.example.workers.dev',
    ])
      expect(() => normalizeGeminiConnection({ ...connection, url })).toThrow();
    expect(() =>
      normalizeGeminiConnection({ ...connection, token: 'AIza' + 'a'.repeat(35) }),
    ).toThrow('Mise access token');
    expect(normalizeGeminiConnection({ ...connection, url: 'http://localhost:8787/' }).url).toBe(
      'http://localhost:8787',
    );
  });

  it('generates a random strong URL-safe pairing token', () => {
    const first = generateGeminiAccessToken();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateGeminiAccessToken()).not.toBe(first);
  });

  it('checks pairing and uses bearer authorization without cookies or URL secrets', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, model: 'gemini-3.5-flash-lite' })),
      );
    vi.stubGlobal('fetch', fetcher);
    expect(await checkGeminiConnection(connection)).toEqual({
      ok: true,
      model: 'gemini-3.5-flash-lite',
    });
    expect(fetcher.mock.calls[0][0]).toBe(`${connection.url}/health`);
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      credentials: 'omit',
      redirect: 'error',
      headers: { Authorization: `Bearer ${connection.token}` },
    });
  });

  it('passes validated context and preserves follow-up conversation', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(reply)));
    vi.stubGlobal('fetch', fetcher);
    const input = {
      message: 'Can I use this pan?',
      inventory: 'Eggs: 2',
      recipe: 'Scrambled eggs',
      history: [{ role: 'user' as const, text: 'Make dinner' }],
    };
    expect(await sendGeminiChat(connection, input)).toEqual(reply);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual(input);
  });

  it('returns actionable quota details instead of retrying automatically', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 'quota', message: 'Try later.', retryAfterSeconds: 60 },
        }),
        { status: 429 },
      ),
    );
    vi.stubGlobal('fetch', fetcher);
    await expect(
      sendGeminiChat(connection, { message: 'Dinner', inventory: '' }),
    ).rejects.toMatchObject({ code: 'quota', retryAfterSeconds: 60 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed recipes from the remote connection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            message: 'Oops',
            recipes: [{ title: 'No ingredients' }],
            warnings: [],
          }),
        ),
      ),
    );
    await expect(
      sendGeminiChat(connection, { message: 'Dinner', inventory: '' }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('requires content to extract, never requests a source link alone', async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    await expect(
      extractGeminiRecipe(connection, { sourceUrl: 'https://example.com/recipe' }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads bounded supported image files and rejects unsafe types', async () => {
    expect(
      await fileToGeminiMedia(
        new File([new Uint8Array([1, 2, 3])], 'recipe.png', { type: 'image/png' }),
      ),
    ).toEqual({ mimeType: 'image/png', data: 'AQID' });
    await expect(
      fileToGeminiMedia(new File(['svg'], 'recipe.svg', { type: 'image/svg+xml' })),
    ).rejects.toMatchObject({ code: 'file_type' });
    await expect(
      fileToGeminiMedia(
        new File([new Uint8Array(MAX_MEDIA_BYTES + 1)], 'recipe.mp4', { type: 'video/mp4' }),
      ),
    ).rejects.toMatchObject({ code: 'file_size' });
  });
});

describe('website import adapter', () => {
  it('requests structured website import with the configured private Worker', async () => {
    const imported = {
      message: 'Imported',
      warnings: [],
      recipes: [
        {
          title: 'Eggs',
          servings: 1,
          ingredients: [{ name: 'egg', quantity: 2, unit: 'each' }],
          steps: ['Cook eggs.'],
        },
      ],
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(imported)));
    vi.stubGlobal('fetch', fetcher);
    expect(await importGeminiRecipeUrl(connection, 'https://recipes.example.com/eggs')).toEqual(
      imported,
    );
    expect(fetcher.mock.calls[0][0]).toBe(`${connection.url}/import`);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      url: 'https://recipes.example.com/eggs',
    });
  });
});

describe('free Worker resource errors', () => {
  it('explains readable Cloudflare resource-limit failures without suggesting a paid tier', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response('Error 1102: Worker exceeded resource limits', { status: 500 }),
        ),
    );
    await expect(
      sendGeminiChat(connection, { message: 'Dinner', inventory: '' }),
    ).rejects.toMatchObject({
      code: 'resource_limit',
      message: expect.stringContaining('smaller/cropped image'),
    });
  });

  it('bounds response streams before parsing excessive data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response('a'.repeat(512 * 1024 + 1))),
    );
    await expect(checkGeminiConnection(connection)).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
});
