// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  runRecipeConversation,
  searchPublisherRecipes,
  recipeDiscoveryConfigured,
} from '../../server/src/recipeDiscovery';
import type { ModelTurn, RecipeConversationModel } from '../../server/src/recipeDiscovery';
import { createWorker } from '../../server/src/index';
import type { Env } from '../../server/src/index';

const url = 'https://recipes.example.com/chicken-bowls';
const env = { TAVILY_API_KEY: 'fake-private-search-key', TAVILY_PLAN: 'free' };
const input = {
  message: 'Help me choose a meal prep recipe',
  inventory: 'Rice: 2 cups',
  discover: true as const,
};
const finish = (ids: string[] = []): ModelTurn => ({
  role: 'model',
  parts: [
    {
      functionCall: {
        name: 'finish_reply',
        args: {
          message: 'Here are the original recipes. Choose one to plan your groceries.',
          warnings: [],
          recommendedRecipeIds: ids,
        },
      },
    },
  ],
});
const call = (name: string, args: object, id = 'tool-1'): ModelTurn => ({
  role: 'model',
  parts: [{ thoughtSignature: 'opaque-signature', functionCall: { name, args, id } }],
});
const publisher = {
  '@type': 'Recipe',
  name: 'Chicken rice bowls',
  recipeYield: '4 servings',
  recipeIngredient: ['2 cups rice', '1 pound chicken'],
  recipeInstructions: ['Cook rice.', 'Cook chicken and serve.'],
  image: 'https://recipes.example.com/bowl.jpg',
  totalTime: 'PT35M',
  author: { name: 'Publisher cook' },
  aggregateRating: { ratingValue: '4.7', ratingCount: '83' },
};
function internet(searchStatus = 200) {
  return vi.fn<typeof fetch>(async (address) => {
    const target = String(address);
    if (target === 'https://api.tavily.com/search')
      return new Response(
        JSON.stringify({
          results: [
            { title: 'Chicken rice bowls', url, content: 'A make-ahead recipe.' },
            { title: 'Private network', url: 'https://127.0.0.1/secret', content: 'Not allowed.' },
          ],
        }),
        { status: searchStatus },
      );
    if (target.startsWith('https://cloudflare-dns.com/dns-query'))
      return new Response(
        JSON.stringify({
          Status: 0,
          Answer: target.endsWith('type=A') ? [{ type: 1, data: '93.184.216.34' }] : [],
        }),
      );
    if (target === url)
      return new Response(
        `<script type="application/ld+json">${JSON.stringify(publisher)}</script>`,
        {
          headers: { 'Content-Type': 'text/html' },
        },
      );
    throw new Error('Unexpected outbound request');
  });
}

describe('publisher discovery conversation', () => {
  it('stops research when the user cancels the pending conversation', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>();
    const model: RecipeConversationModel = (_contents, _tools, _finish, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Conversation cancelled')), {
          once: true,
        });
      });
    const pending = runRecipeConversation(input, [], env, model, fetcher, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('Conversation cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('retrieves real original recipe cards and preserves thought signatures and call IDs', async () => {
    const fetcher = internet();
    const model = vi
      .fn<RecipeConversationModel>()
      .mockResolvedValueOnce(
        call('search_recipes', { query: 'simple meal prep chicken rice bowls recipe' }),
      )
      .mockResolvedValueOnce(call('fetch_recipe', { url }, 'fetch-1'))
      .mockImplementationOnce(async (contents) => {
        const turn = contents.at(-1) as ModelTurn;
        const response = turn.parts[0].functionResponse as { response: { recipe: { id: string } } };
        return finish([response.response.recipe.id]);
      });
    const result = await runRecipeConversation(input, [], env, model, fetcher);
    expect(result.sourceRecipes).toHaveLength(1);
    expect(result.sourceRecipes![0]).toMatchObject({
      title: publisher.name,
      servings: 4,
      steps: publisher.recipeInstructions,
      source: { type: 'imported', url },
      imageUrl: publisher.image,
      totalMinutes: 35,
      author: 'Publisher cook',
      rating: { value: 4.7, count: 83 },
    });
    expect(result.recommendedRecipeIds).toEqual([result.sourceRecipes![0].id]);
    expect(result.recipes).toEqual([]);
    expect(JSON.stringify(model.mock.calls[1][0])).toContain('opaque-signature');
    expect(JSON.stringify(model.mock.calls[2][0])).toContain('fetch-1');
    const search = JSON.parse(
      String(
        fetcher.mock.calls.find(([address]) => String(address).includes('api.tavily'))![1]!.body,
      ),
    );
    expect(search).toMatchObject({
      search_depth: 'basic',
      auto_parameters: false,
      include_raw_content: false,
    });
    expect(JSON.stringify(search)).not.toContain(input.inventory);
    expect(fetcher.mock.calls.every(([, options]) => options?.redirect === 'manual')).toBe(true);
  });

  it('has a natural conversation without a configured search key or forced recipe generation', async () => {
    const model = vi.fn<RecipeConversationModel>().mockResolvedValue({
      role: 'model',
      parts: [{ text: 'What kind of meal sounds appealing tonight?' }],
    });
    const fetcher = vi.fn<typeof fetch>();
    const reply = await runRecipeConversation(input, [], {}, model, fetcher);
    expect(reply).toMatchObject({
      message: 'What kind of meal sounds appealing tonight?',
      recipes: [],
      warnings: [],
      recommendedRecipeIds: [],
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(model.mock.calls[0][1])).not.toContain('search_recipes');
    expect(recipeDiscoveryConfigured({ ...env, TAVILY_PLAN: 'paid' })).toBe(false);
  });

  it('can fetch a user-provided public recipe link without a search account', async () => {
    const model = vi
      .fn<RecipeConversationModel>()
      .mockResolvedValueOnce(call('fetch_recipe', { url }))
      .mockResolvedValueOnce(finish());
    const fetcher = internet();
    expect(
      (await runRecipeConversation({ ...input, message: `Explain ${url}` }, [], {}, model, fetcher))
        .sourceRecipes,
    ).toHaveLength(1);
    expect(fetcher.mock.calls.some(([address]) => String(address).includes('api.tavily'))).toBe(
      false,
    );
  });

  it('does not fetch invented, unrelated, private, or credentials-bearing URLs', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const model = vi
      .fn<RecipeConversationModel>()
      .mockResolvedValueOnce({
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'fetch_recipe',
              args: { url: 'https://unknown.example.com/private' },
            },
          },
          { functionCall: { name: 'fetch_recipe', args: { url: 'https://localhost/secret' } } },
          {
            functionCall: {
              name: 'fetch_recipe',
              args: { url: 'https://user:password@recipes.example.com/private' },
            },
          },
        ],
      })
      .mockResolvedValueOnce(finish());
    await runRecipeConversation(input, [], env, model, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(model.mock.calls[1][0])).toContain('Only exact search-result');
  });

  it('rejects fabricated recommendation IDs even when valid originals were retrieved', async () => {
    const model = vi.fn<RecipeConversationModel>().mockResolvedValue(finish(['invented-original']));
    await expect(runRecipeConversation(input, [], env, model, internet())).rejects.toThrow(
      'invalid_discovery_reply',
    );
  });

  it('limits research and does not silently turn quota failures into zero matches', async () => {
    const fetcher = internet(432);
    const model = vi
      .fn<RecipeConversationModel>()
      .mockResolvedValueOnce(call('search_recipes', { query: 'meal prep' }))
      .mockResolvedValueOnce(call('search_recipes', { query: 'pasta meal prep' }))
      .mockResolvedValueOnce(call('search_recipes', { query: 'another search' }))
      .mockResolvedValueOnce(finish());
    const result = await runRecipeConversation(input, [], env, model, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.warnings.join(' ')).toContain('No paid search was attempted');
    expect(model.mock.calls[3][2]).toBe(true);
  });

  it('keeps inspected originals available after a later Gemini failure', async () => {
    const model = vi
      .fn<RecipeConversationModel>()
      .mockResolvedValueOnce(call('fetch_recipe', { url }))
      .mockRejectedValueOnce(new Error('Google quota unavailable'));
    const result = await runRecipeConversation(
      { ...input, message: `Consider ${url}` },
      [],
      {},
      model,
      internet(),
    );
    expect(result.sourceRecipes).toHaveLength(1);
    expect(result.message).toContain('could not finish comparing');
    expect(result.warnings).toContain('Google quota unavailable');
  });

  it('does not follow search-service redirects or accept unsupported result addresses', async () => {
    const fetcher = internet();
    const result = await searchPublisherRecipes(
      'meal prep',
      env,
      fetcher,
      new AbortController().signal,
    );
    expect(result.results.map((item) => item.url)).toEqual([url]);
    const redirects = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { Location: 'https://attacker.example.com' } }),
      );
    expect(
      (await searchPublisherRecipes('meal prep', env, redirects, new AbortController().signal))
        .error,
    ).toContain('not a zero-result');
    expect(redirects).toHaveBeenCalledTimes(1);
  });
});

describe('Worker assistant tools and diagnostics', () => {
  const origin = 'https://kitchen.example';
  const workerEnv: Env = {
    ALLOWED_ORIGIN: origin,
    MISE_ACCESS_TOKEN: 'a'.repeat(43),
    GEMINI_API_KEY: 'not-real-private-google-key',
  };
  const request = (path: string, data?: unknown) =>
    new Request(`https://mise.example.workers.dev${path}`, {
      method: data ? 'POST' : 'GET',
      headers: {
        Origin: origin,
        Authorization: `Bearer ${workerEnv.MISE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
  it('reports discovery configuration without spending Google or search quota', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const worker = createWorker(fetcher);
    expect(await (await worker.fetch(request('/health'), workerEnv)).json()).toMatchObject({
      supportsRecipeDiscovery: true,
      recipeDiscoveryConfigured: false,
    });
    expect(
      await (await worker.fetch(request('/health'), { ...workerEnv, ...env })).json(),
    ).toMatchObject({ recipeDiscoveryConfigured: true });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('uses native functions for discovery while retaining ordinary conversational responses', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: finish() }] })),
      );
    const response = await createWorker(fetcher).fetch(request('/chat', input), workerEnv);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ recipes: [], recommendedRecipeIds: [] });
    const body = JSON.parse(String(fetcher.mock.calls[0][1]!.body));
    expect(body.generationConfig.responseSchema).toBeUndefined();
    expect(body.tools[0].functionDeclarations[0].name).toBe('finish_reply');
    expect(body.systemInstruction.parts[0].text).toContain('not a restriction');
    expect(body.systemInstruction.parts[0].text).toContain(
      'without requiring an exact target or inventing a midpoint',
    );
    expect(body.systemInstruction.parts[0].text).toContain(
      'a single meal does not satisfy an entire daily goal',
    );
  });
  it('identifies Google model request failures and redacts private keys from diagnostics', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { message: `Unsupported schema. key=${workerEnv.GEMINI_API_KEY}` },
        }),
        { status: 400 },
      ),
    );
    const response = await createWorker(fetcher).fetch(
      request('/chat', { ...input, model: 'gemini-3.8-flash' }),
      workerEnv,
    );
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).toContain('gemini-3.8-flash');
    expect(body).toContain('Unsupported schema');
    expect(body).not.toContain(workerEnv.GEMINI_API_KEY);
  });

  it('keeps reviewed report ranges usable for portion planning in legacy and library conversations', async () => {
    for (const candidates of [
      undefined,
      [
        {
          id: 'saved-original',
          title: 'Bowls',
          servings: 4,
          ingredients: ['rice'],
          missingIngredients: [],
        },
      ],
    ]) {
      const reply = {
        message: 'We can compare the source recipe with your report range.',
        recipes: [],
        warnings: [],
        ...(candidates ? { recommendedRecipeIds: [] } : {}),
      };
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            candidates: [
              { finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(reply) }] } },
            ],
          }),
        ),
      );
      const response = await createWorker(fetcher).fetch(
        request('/chat', {
          message: 'Plan portions using the recommended daily ranges in my reviewed report.',
          inventory: '',
          profile: 'Recommended daily protein: 100–130 g. BMR: 1650 kcal.',
          ...(candidates ? { candidates } : {}),
        }),
        workerEnv,
      );
      expect(response.status).toBe(200);
      const body = JSON.parse(String(fetcher.mock.calls[0][1]!.body));
      expect(body.systemInstruction.parts[0].text).toContain(
        'use those literal ranges as sourced planning context',
      );
      expect(body.systemInstruction.parts[0].text).toContain(
        'never turn BMR, BMI, body fat or energy expenditure into intake goals',
      );
      expect(body.contents.at(-1).parts[0].text).toContain('100–130 g');
      expect(body.contents.at(-1).parts[0].text).not.toContain('approvedDailyNutritionTargets');
    }
  });
});
