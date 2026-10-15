import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkGeminiConnection,
  discoverGeminiModels,
  clearGeminiConnection,
  extractGeminiRecipe,
  extractGeminiNutrition,
  extractGeminiBodyScan,
  fileToGeminiMedia,
  fileToBodyScanMedia,
  importGeminiRecipeUrl,
  generateGeminiAccessToken,
  normalizeGeminiConnection,
  readGeminiConnection,
  readGeminiConnectionDraft,
  saveGeminiConnectionDraft,
  saveGeminiConnection,
  sendGeminiChat,
} from './client';
import { MAX_MEDIA_BYTES, MAX_BODY_SCAN_BYTES } from './protocol';
import { GEMINI_PRICING_URL } from './models';

const connection = { url: 'https://mise.example.workers.dev', token: 'a'.repeat(43) };
const reply = { message: 'Try scrambled eggs.', recipes: [], warnings: [] };

beforeEach(() => {
  clearGeminiConnection();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('Gemini browser adapter', () => {
  it('uses the previous Worker conversation without dropping context and explains one required update', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { code: 'invalid_request', message: 'Unknown discover field.' },
          }),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(reply)))
      .mockResolvedValueOnce(new Response(JSON.stringify(reply)));
    vi.stubGlobal('fetch', fetcher);
    const context = {
      message: 'How do I reheat this?',
      inventory: 'Eggs: 2',
      recipe: 'Original rice recipe',
      profile: 'Reviewed recommended values',
      history: [{ role: 'user' as const, text: 'Plan dinner' }],
      discover: true as const,
    };
    const first = await sendGeminiChat(connection, context);
    expect(first.warnings.join(' ')).toContain('Update its code');
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual(context);
    const oldContext: Partial<typeof context> = { ...context };
    delete oldContext.discover;
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual(oldContext);
    expect((await sendGeminiChat(connection, context)).warnings).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('restores discovery after checking an updated Worker without changing its saved model', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, model: 'gemini-3.5-flash-lite' })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(reply)))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            model: 'gemini-3.5-flash-lite',
            supportsRecipeDiscovery: true,
            recipeDiscoveryConfigured: true,
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...reply, sourceRecipes: [], recommendedRecipeIds: [] })),
      );
    vi.stubGlobal('fetch', fetcher);
    await checkGeminiConnection(connection);
    await sendGeminiChat(connection, { message: 'Question', inventory: '', discover: true });
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body)).discover).toBeUndefined();
    expect(await checkGeminiConnection(connection)).toMatchObject({
      supportsRecipeDiscovery: true,
      recipeDiscoveryConfigured: true,
    });
    await sendGeminiChat(connection, {
      message: 'Find a real recipe',
      inventory: '',
      discover: true,
    });
    expect(JSON.parse(String(fetcher.mock.calls[3][1]?.body)).discover).toBe(true);
  });
  it('accepts a copied Worker hostname and normalizes surrounding whitespace', () => {
    expect(
      normalizeGeminiConnection({
        url: '  mise.example.workers.dev/  ',
        token: ` ${connection.token} `,
      }),
    ).toEqual(connection);
    expect(normalizeGeminiConnection({ ...connection, url: ` ${connection.url}/ ` })).toEqual(
      connection,
    );
    expect(() => normalizeGeminiConnection({ ...connection, url: 'example.workers.dev' })).toThrow(
      'Include the Worker name',
    );
  });

  it('remembers unfinished setup without activating it and clears drafts on save or disconnect', () => {
    const draft = { url: 'mise.example.workers.dev', token: 'unfinished' };
    saveGeminiConnectionDraft(draft);
    expect(readGeminiConnectionDraft()).toEqual(draft);
    expect(readGeminiConnection()).toBeNull();
    saveGeminiConnection(connection);
    expect(readGeminiConnectionDraft()).toBeNull();
    expect(readGeminiConnection()).toEqual(connection);
    saveGeminiConnectionDraft(draft);
    clearGeminiConnection();
    expect(readGeminiConnectionDraft()).toBeNull();
    expect(readGeminiConnection()).toBeNull();
  });

  it('never persists a Google API key as an unfinished pairing token', () => {
    saveGeminiConnectionDraft({ ...connection, token: '  AIza' + 'a'.repeat(35) });
    expect(readGeminiConnectionDraft()).toEqual({ url: connection.url, token: '' });
    expect(JSON.stringify(localStorage)).not.toContain('AIza');
  });

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
      'attacker.example',
      'mise.example.workers.dev.attacker.example',
      'mise.example.workers.dev/chat',
      'https://mise.example.workers.dev/#secret',
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

  it('rejects oversized combined report and history context before sending', async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    await expect(
      sendGeminiChat(connection, {
        message: '\u0000'.repeat(6000),
        inventory: '\u0000'.repeat(24000),
        profile: '\u0000'.repeat(24000),
        recipe: '\u0000'.repeat(12000),
        history: Array.from({ length: 5 }, () => ({ role: 'user', text: '\u0000'.repeat(6000) })),
      }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      message: expect.stringContaining('remove an attached body scan or recipe'),
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('checks grounded recipe IDs even when an older or misconfigured Worker returns them', async () => {
    const candidates = [
      {
        id: 'real-recipe',
        title: 'Chili',
        servings: 4,
        ingredients: ['beans'],
        missingIngredients: [],
      },
    ];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...reply, recommendedRecipeIds: ['real-recipe'] })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...reply, recommendedRecipeIds: ['invented-recipe'] })),
      );
    vi.stubGlobal('fetch', fetcher);
    const input = { message: 'Dinner', inventory: '', candidates };
    expect((await sendGeminiChat(connection, input)).recommendedRecipeIds).toEqual(['real-recipe']);
    await expect(sendGeminiChat(connection, input)).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('explains the required Worker update when an older chat endpoint rejects recipe candidates', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ error: { code: 'invalid_request', message: 'Unsupported request.' } }),
            { status: 400 },
          ),
        ),
    );
    await expect(
      sendGeminiChat(connection, {
        message: 'Choose dinner',
        inventory: '',
        candidates: [
          {
            id: 'real',
            title: 'Chili',
            servings: 4,
            ingredients: ['beans'],
            missingIngredients: [],
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'worker_update',
      message: expect.stringContaining('latest Mise Worker file'),
    });
  });

  it('extracts daily targets for review without saving them and never sends a video report', async () => {
    const result = {
      targets: { caloriesKcal: 2000, proteinGrams: null, carbsGrams: null, fatGrams: null },
      sourceText: 'Recommended daily intake 2000 kcal',
      warnings: ['Other targets not stated.'],
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(result)));
    vi.stubGlobal('fetch', fetcher);
    expect(await extractGeminiNutrition(connection, { text: result.sourceText })).toEqual(result);
    expect(fetcher.mock.calls[0][0]).toBe(`${connection.url}/nutrition/extract`);
    expect(localStorage.length).toBe(0);
    await expect(
      extractGeminiNutrition(connection, { media: { mimeType: 'video/mp4', data: 'AQID' } }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reads complete report text and dates for review without saving or attaching the file', async () => {
    const result = {
      text: 'Scan date: October 1, 2026\nBMR: 1650 kcal\nBody fat: 20%',
      recordedOn: '2026-10-01',
      targets: { caloriesKcal: null, proteinGrams: null, carbsGrams: null, fatGrams: null },
      warnings: ['No explicitly recommended daily targets.'],
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(result)));
    vi.stubGlobal('fetch', fetcher);
    const input = { media: { mimeType: 'application/pdf', data: 'AQID' } };
    expect(await extractGeminiBodyScan(connection, input)).toEqual(result);
    expect(fetcher.mock.calls[0][0]).toBe(`${connection.url}/profile/extract`);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual(input);
    expect(localStorage.length).toBe(0);
    await expect(
      extractGeminiBodyScan(connection, { media: { mimeType: 'video/mp4', data: 'AQID' } }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('accepts PDF/image reports up to 4 MB and leaves recipe media limits unchanged', async () => {
    expect(await fileToBodyScanMedia(new File(['pdf'], 'scan.pdf'))).toEqual({
      mimeType: 'application/pdf',
      data: 'cGRm',
    });
    const largeImage = new File([new Uint8Array(MAX_MEDIA_BYTES + 1)], 'scan.png', {
      type: 'image/png',
    });
    expect((await fileToBodyScanMedia(largeImage)).mimeType).toBe('image/png');
    await expect(fileToGeminiMedia(largeImage)).rejects.toMatchObject({ code: 'file_size' });
    await expect(
      fileToBodyScanMedia(
        new File([new Uint8Array(MAX_BODY_SCAN_BYTES + 1)], 'scan.pdf', {
          type: 'application/pdf',
        }),
      ),
    ).rejects.toMatchObject({ code: 'file_size' });
    await expect(
      fileToBodyScanMedia(new File(['video'], 'scan.mp4', { type: 'video/mp4' })),
    ).rejects.toMatchObject({ code: 'file_type' });
  });

  it('explains an older Worker when report reading or selected profile context is rejected', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 'not_found', message: 'Unknown route.' } }), {
          status: 404,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: 'invalid_request', message: 'Unsupported request.' } }),
          { status: 400 },
        ),
      );
    vi.stubGlobal('fetch', fetcher);
    await expect(extractGeminiBodyScan(connection, { text: 'Body scan' })).rejects.toMatchObject({
      code: 'worker_update',
    });
    await expect(
      sendGeminiChat(connection, { message: 'Dinner', inventory: '', profile: 'Selected scan' }),
    ).rejects.toMatchObject({ code: 'worker_update' });
  });

  it('persists a chosen model and verifies the Worker recognizes it without a generation request', async () => {
    const selected = { ...connection, model: 'gemini-3.8-flash' as const };
    saveGeminiConnectionDraft(selected);
    expect(readGeminiConnectionDraft()).toEqual(selected);
    saveGeminiConnection(selected);
    expect(readGeminiConnection()).toEqual(selected);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, model: selected.model })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, model: 'gemini-3.5-flash-lite' })),
      );
    vi.stubGlobal('fetch', fetcher);
    expect(await checkGeminiConnection(selected)).toEqual({ ok: true, model: selected.model });
    expect(fetcher.mock.calls[0][0]).toBe(`${connection.url}/health?model=${selected.model}`);
    await expect(checkGeminiConnection(selected)).rejects.toMatchObject({ code: 'worker_update' });
  });

  it('persists a reviewed discovered model and includes that review in its health check', async () => {
    const selected = { ...connection, model: 'gemini-4.0-flash', modelReviewed: true as const };
    saveGeminiConnectionDraft(selected);
    expect(readGeminiConnectionDraft()).toEqual(selected);
    saveGeminiConnection(selected);
    expect(readGeminiConnection()).toEqual(selected);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true, model: selected.model })));
    vi.stubGlobal('fetch', fetcher);
    await expect(checkGeminiConnection(selected)).resolves.toEqual({
      ok: true,
      model: selected.model,
    });
    expect(fetcher.mock.calls[0][0]).toBe(
      `${connection.url}/health?model=${selected.model}&modelReviewed=1`,
    );
  });

  it('blocks unreviewed selections and malformed stored approvals before reaching the Worker', async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    const selected = { ...connection, model: 'gemini-4.0-flash' };
    expect(() => saveGeminiConnection(selected)).toThrow('Review and approve');
    expect(() => saveGeminiConnectionDraft(selected)).toThrow('Review');
    await expect(checkGeminiConnection(selected)).rejects.toMatchObject({ code: 'settings' });
    await expect(
      sendGeminiChat(selected, { message: 'Dinner', inventory: '' }),
    ).rejects.toMatchObject({ code: 'settings' });
    await expect(
      sendGeminiChat(connection, { message: 'Dinner', inventory: '', model: selected.model }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetcher).not.toHaveBeenCalled();
    for (const invalid of [
      selected,
      { ...connection, modelReviewed: true },
      { ...selected, modelReviewed: 'true' },
    ]) {
      localStorage.setItem('mise.gemini.connection.v1', JSON.stringify(invalid));
      localStorage.setItem('mise.gemini.connection-draft.v1', JSON.stringify(invalid));
      expect(readGeminiConnection()).toBeNull();
      expect(readGeminiConnectionDraft()).toBeNull();
    }
  });

  it('discovers current models without saving or selecting them and can request a fresh catalog', async () => {
    saveGeminiConnection(connection);
    const catalog = {
      models: [
        {
          id: 'gemini-4.0-flash',
          name: 'Gemini 4.0 Flash',
          description: '',
          inputTokenLimit: null,
          outputTokenLimit: null,
          freeTier: 'verified',
        },
      ],
      checkedAt: '2026-10-13T12:00:00.000Z',
      pricingUrl: GEMINI_PRICING_URL,
      warnings: [],
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(new Response(JSON.stringify(catalog))));
    vi.stubGlobal('fetch', fetcher);
    expect(await discoverGeminiModels(connection)).toEqual(catalog);
    expect(await discoverGeminiModels(connection, { refresh: true })).toEqual(catalog);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      `${connection.url}/models`,
      `${connection.url}/models?refresh=1`,
    ]);
    expect(
      fetcher.mock.calls.every(
        ([, options]) => options?.method === 'GET' && options.body === undefined,
      ),
    ).toBe(true);
    expect(readGeminiConnection()).toEqual(connection);
  });

  it('rejects invalid discovery catalogs and explains the update needed by an older Worker', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [] })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 'not_found', message: 'Unknown route.' } }), {
          status: 404,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: 'invalid_request', message: 'Unsupported query.' } }),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(new Response('Not found', { status: 404 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(discoverGeminiModels(connection)).rejects.toMatchObject({
      code: 'invalid_response',
    });
    await expect(discoverGeminiModels(connection)).rejects.toMatchObject({
      code: 'worker_update',
      message: expect.stringContaining('latest Mise Worker file'),
    });
    await expect(discoverGeminiModels(connection, { refresh: true })).rejects.toMatchObject({
      code: 'worker_update',
    });
    await expect(discoverGeminiModels(connection)).rejects.toMatchObject({
      code: 'worker_update',
    });
  });

  it('preserves paid or unverified model refusals instead of suggesting an update or another model', async () => {
    const selected = { ...connection, model: 'gemini-4.0-pro', modelReviewed: true as const };
    const refusal = {
      code: 'model_not_free',
      message: 'This model has no verified free input and output tier.',
    };
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockImplementation(() =>
          Promise.resolve(new Response(JSON.stringify({ error: refusal }), { status: 422 })),
        ),
    );
    await expect(checkGeminiConnection(selected)).rejects.toMatchObject(refusal);
    await expect(
      sendGeminiChat(selected, { message: 'Dinner', inventory: '' }),
    ).rejects.toMatchObject(refusal);
    await expect(extractGeminiRecipe(selected, { text: 'Recipe' })).rejects.toMatchObject(refusal);
    await expect(extractGeminiNutrition(selected, { text: 'Daily targets' })).rejects.toMatchObject(
      refusal,
    );
    await expect(extractGeminiBodyScan(selected, { text: 'Report' })).rejects.toMatchObject(
      refusal,
    );
  });

  it('applies the saved model to every Gemini task and keeps website import free of overrides', async () => {
    const selected = { ...connection, model: 'gemini-4.0-flash', modelReviewed: true as const };
    const scan = {
      text: 'BMR: 1650 kcal',
      recordedOn: null,
      targets: { caloriesKcal: null, proteinGrams: null, carbsGrams: null, fatGrams: null },
      warnings: [],
    };
    const recipe = {
      title: 'Eggs',
      servings: 1,
      ingredients: [{ name: 'egg', quantity: 1, unit: 'each' }],
      steps: ['Cook.'],
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(reply)))
      .mockResolvedValueOnce(new Response(JSON.stringify(reply)))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ targets: scan.targets, sourceText: scan.text, warnings: [] }),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(scan)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...reply, recipes: [recipe] })));
    vi.stubGlobal('fetch', fetcher);
    await sendGeminiChat(selected, { message: 'Dinner', inventory: '', profile: scan.text });
    await extractGeminiRecipe(selected, { text: 'Recipe' });
    await extractGeminiNutrition(selected, { text: 'Targets' });
    await extractGeminiBodyScan(selected, { text: scan.text });
    await importGeminiRecipeUrl(selected, 'https://example.com/recipe');
    for (const [, options] of fetcher.mock.calls.slice(0, 4))
      expect(JSON.parse(String(options?.body))).toMatchObject({
        model: selected.model,
        modelReviewed: true,
      });
    expect(JSON.parse(String(fetcher.mock.calls[4][1]?.body))).toEqual({
      url: 'https://example.com/recipe',
    });
  });

  it('overrides a request model and its approval together with the saved model selection', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(new Response(JSON.stringify(reply))));
    vi.stubGlobal('fetch', fetcher);
    await sendGeminiChat(
      { ...connection, model: 'gemini-3.8-flash' },
      { message: 'Dinner', inventory: '', model: 'gemini-4.0-flash', modelReviewed: true },
    );
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      message: 'Dinner',
      inventory: '',
      model: 'gemini-3.8-flash',
    });
    await sendGeminiChat(
      { ...connection, model: 'gemini-4.0-flash', modelReviewed: true },
      { message: 'Dinner', inventory: '', model: 'gemini-3.8-flash' },
    );
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({
      message: 'Dinner',
      inventory: '',
      model: 'gemini-4.0-flash',
      modelReviewed: true,
    });
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
