import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import process from 'node:process';
import {
  Miniflare,
  convertV4MiniflareOptions,
} from '../server/node_modules/miniflare/dist/src/index.js';

// Exercise the built dashboard bundle in workerd, not Node's Fetch implementation.
// Every outbound request is intercepted; these tests need no accounts or network.
const script = await readFile(new URL('../server/dist/index.js', import.meta.url), 'utf8');
const { Response } = globalThis;
const origin = 'https://kitchen.example';
const token = 'test_only_' + 'a'.repeat(40);
const bindings = {
  ALLOWED_ORIGIN: origin,
  GEMINI_API_KEY: 'test-only-not-real-gemini-key',
  MISE_ACCESS_TOKEN: token,
  RECIPEAPI_API_KEY: 'sk_live_' + 'test_only_'.repeat(4),
  RECIPEAPI_PLAN: 'free',
  SPOONACULAR_API_KEY: 'test_only_'.repeat(4),
  SPOONACULAR_PLAN: 'free',
  USDA_API_KEY: 'test_only_usda_not_a_real_key',
  TAVILY_API_KEY: 'test_only_tavily_not_a_real_key',
  TAVILY_PLAN: 'free',
};
const recipeApi = {
  data: [
    {
      id: 1,
      name: 'Runtime fixture soup',
      ingredients: [{ name: 'Carrots', quantity: 300, unit: 'g' }],
      instructions: ['Test-only: simmer.'],
    },
  ],
  meta: { last_page: 1 },
};
const spoonacular = {
  results: [
    {
      id: 2,
      title: 'Runtime fixture soup',
      usedIngredients: [],
      missedIngredients: [{ name: 'Carrots', amount: 300, unit: 'g', original: '300 g carrots' }],
      analyzedInstructions: [{ steps: [{ step: 'Test-only: simmer.' }] }],
      sourceUrl: 'https://recipes.example.com/soup',
    },
  ],
  totalResults: 1,
};
const json = (body, init) => new Response(JSON.stringify(body), init);
const geminiAnswer = (body) =>
  json({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(body) }] } }],
  });
const discoveredModel = 'gemini-9-flash';
const discoveredModels = {
  models: [discoveredModel, 'gemini-9-pro'].map((id) => ({
    name: `models/${id}`,
    displayName: id,
    supportedGenerationMethods: ['generateContent'],
    inputTokenLimit: 100000,
    outputTokenLimit: 8000,
  })),
};
const discoveryPricing = [discoveredModel, 'gemini-9-pro']
  .map((id) => {
    const price = id === discoveredModel ? 'Free of charge' : 'Not available';
    return `<h2>${id}</h2><code>${id}</code><h3>Standard</h3><table><thead><tr><th></th><th>Free Tier</th><th>Paid Tier</th></tr></thead><tbody><tr><td>Input price</td><td>${price}</td><td>$1</td></tr><tr><td>Output price (including thinking tokens)</td><td>${price}</td><td>$2</td></tr></tbody></table>`;
  })
  .join('');
const discoveryUpstream = (request) => {
  const url = new URL(request.url);
  if (url.hostname === 'ai.google.dev') {
    assert.equal(request.headers.get('x-goog-api-key'), null);
    assert.equal(url.pathname, '/gemini-api/docs/pricing');
    return new Response(discoveryPricing);
  }
  assert.equal(url.hostname, 'generativelanguage.googleapis.com');
  assert.equal(request.headers.get('x-goog-api-key'), bindings.GEMINI_API_KEY);
  assert.equal(url.pathname, '/v1beta/models');
  return json(discoveredModels);
};
const groundedInput = {
  message: 'Help me choose dinner',
  inventory: '',
  candidates: [
    {
      id: 'actual-fixture',
      title: 'Runtime fixture chili',
      servings: 4,
      ingredients: ['300 g beans'],
      missingIngredients: ['beans'],
    },
  ],
};

async function run(date, path, payload, upstream, verify) {
  const calls = [];
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script,
      compatibilityDate: date,
      bindings,
      outboundService(request) {
        calls.push(request);
        assert.equal(request.headers.get('Cache-Control'), 'no-cache, no-store');
        assert.equal(request.headers.get('Pragma'), 'no-cache');
        return upstream(request);
      },
    }),
  );
  try {
    const response = await runtime.dispatchFetch('https://mise.example.workers.dev' + path, {
      method: payload === undefined ? 'GET' : 'POST',
      headers: {
        Origin: origin,
        Authorization: `Bearer ${token}`,
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    await verify(response, calls, runtime);
  } finally {
    await runtime.dispose();
  }
}

let passed = 0;
for (const date of ['2024-10-01', '2026-10-10']) {
  await run(
    date,
    '/health',
    undefined,
    () => assert.fail('Health must not consume recipe search quota.'),
    async (response, calls) => {
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.supportsRecipeDiscovery, true);
      assert.equal(body.recipeDiscoveryConfigured, true);
      assert.equal(calls.length, 0);
    },
  );
  passed++;
  let conversationTurn = 0;
  await run(
    date,
    '/chat',
    {
      message: 'Find me a meal-prep recipe. I am happy to shop.',
      inventory: 'Rice: 1 cup',
      discover: true,
    },
    async (request) => {
      const url = new URL(request.url);
      if (url.hostname === 'api.tavily.com') {
        assert.equal(request.headers.get('Authorization'), `Bearer ${bindings.TAVILY_API_KEY}`);
        const input = await request.json();
        assert.equal(input.search_depth, 'basic');
        assert.equal(input.auto_parameters, false);
        return json({
          results: [
            {
              title: 'Publisher fixture rice',
              url: 'https://recipes.example.com/rice',
              content: 'An original recipe with four servings.',
            },
          ],
        });
      }
      if (url.hostname === 'cloudflare-dns.com')
        return json({
          Status: 0,
          Answer: url.searchParams.get('type') === 'A' ? [{ type: 1, data: '93.184.216.34' }] : [],
        });
      if (url.hostname === 'recipes.example.com') {
        return new Response(
          `<script type="application/ld+json">${JSON.stringify({ '@type': 'Recipe', name: 'Publisher fixture rice', recipeYield: '4 servings', recipeIngredient: ['2 cups rice', '1 cup carrots'], recipeInstructions: ['Cook according to the original fixture instructions.'], image: 'https://recipes.example.com/rice.jpg', totalTime: 'PT30M', nutrition: { servingSize: '1 serving', calories: '400 kcal', proteinContent: '20 g' } })}</script>`,
          { headers: { 'Content-Type': 'text/html' } },
        );
      }
      assert.equal(url.hostname, 'generativelanguage.googleapis.com');
      const input = await request.json();
      assert.ok(input.tools[0].functionDeclarations.some((tool) => tool.name === 'finish_reply'));
      assert.equal(
        input.generationConfig.responseMimeType,
        undefined,
        'Conversation allows native tool use and normal text.',
      );
      conversationTurn++;
      let call;
      if (conversationTurn === 1)
        call = { name: 'search_recipes', args: { query: 'simple meal prep rice recipe' } };
      else if (conversationTurn === 2)
        call = { name: 'fetch_recipe', args: { url: 'https://recipes.example.com/rice' } };
      else {
        const recipe = input.contents.at(-1).parts[0].functionResponse.response.recipe;
        assert.equal(recipe.ingredients[0].quantity, 2);
        assert.equal(recipe.totalMinutes, 30);
        call = {
          name: 'finish_reply',
          args: {
            message:
              'This original dish is an option; the shopping list will account for your rice.',
            warnings: [],
            recommendedRecipeIds: [recipe.id],
          },
        };
      }
      return json({
        candidates: [
          { finishReason: 'STOP', content: { role: 'model', parts: [{ functionCall: call }] } },
        ],
      });
    },
    async (response, calls) => {
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
      const reply = await response.json();
      assert.equal(reply.sourceRecipes.length, 1);
      assert.equal(reply.sourceRecipes[0].source.url, 'https://recipes.example.com/rice');
      assert.equal(reply.sourceRecipes[0].publisherNutrition.calories, '400 kcal');
      assert.deepEqual(reply.recommendedRecipeIds, [reply.sourceRecipes[0].id]);
      assert.equal(conversationTurn, 3);
      assert.equal(calls.length, 7);
      assert.ok(!JSON.stringify(reply).includes(bindings.TAVILY_API_KEY));
    },
  );
  passed++;
  await run(
    date,
    '/recipe-providers',
    undefined,
    () => assert.fail('Configuration must not fetch.'),
    async (response, calls) => {
      assert.equal(response.status, 200);
      assert.equal(calls.length, 0);
      assert.ok((await response.json()).providers.every((provider) => provider.configured));
    },
  );
  passed++;
  await run(date, '/models', undefined, discoveryUpstream, async (response, calls) => {
    assert.equal(response.status, 200);
    const catalog = await response.json();
    assert.equal(catalog.models.find((model) => model.id === discoveredModel).freeTier, 'verified');
    assert.equal(
      catalog.models.find((model) => model.id === 'gemini-9-pro').freeTier,
      'unavailable',
    );
    assert.equal(calls.length, 2);
    assert.ok(!JSON.stringify(catalog).includes(bindings.GEMINI_API_KEY));
  });
  passed++;
  await run(
    date,
    `/health?model=${discoveredModel}&modelReviewed=1`,
    undefined,
    discoveryUpstream,
    async (response, calls) => {
      assert.equal(response.status, 200);
      assert.equal((await response.json()).model, discoveredModel);
      assert.equal(calls.length, 2, 'Dynamic model health checks only metadata and pricing.');
    },
  );
  passed++;
  for (const path of ['/chat', '/extract']) {
    await run(
      date,
      path,
      {
        ...(path === '/chat'
          ? { message: 'Fixture dinner', inventory: '' }
          : { text: 'Fixture recipe' }),
        model: discoveredModel,
        modelReviewed: true,
      },
      (request) => {
        if (!new URL(request.url).pathname.endsWith(':generateContent'))
          return discoveryUpstream(request);
        assert.equal(
          new URL(request.url).pathname,
          `/v1beta/models/${discoveredModel}:generateContent`,
        );
        return geminiAnswer({ message: 'Fixture answer.', warnings: [], recipes: [] });
      },
      async (response, calls) => {
        assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
        assert.equal(calls.length, 3);
      },
    );
    passed++;
  }
  await run(
    date,
    '/chat',
    { message: 'Fixture dinner', inventory: '', model: 'gemini-9-pro', modelReviewed: true },
    discoveryUpstream,
    async (response, calls) => {
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error.code, 'model_unverified');
      assert.equal(calls.length, 2, 'Paid models must never trigger generation.');
    },
  );
  passed++;
  await run(
    date,
    '/chat',
    { message: 'Fixture dinner', inventory: '', model: discoveredModel },
    () => assert.fail('An unreviewed model must not fetch anything.'),
    async (response, calls) => {
      assert.equal(response.status, 400);
      assert.equal(calls.length, 0);
    },
  );
  passed++;
  let pricingChecks = 0;
  await run(
    date,
    '/models',
    undefined,
    (request) => {
      if (new URL(request.url).hostname === 'ai.google.dev' && ++pricingChecks > 1)
        return new Response(null, { status: 503 });
      return discoveryUpstream(request);
    },
    async (response, calls, runtime) => {
      assert.equal(response.status, 200);
      const headers = { Origin: origin, Authorization: `Bearer ${token}` };
      const refreshed = await runtime.dispatchFetch(
        'https://mise.example.workers.dev/models?refresh=1',
        { headers },
      );
      assert.equal(refreshed.status, 200);
      assert.equal(
        (await refreshed.json()).models.find((model) => model.id === discoveredModel).freeTier,
        'unknown',
      );
      const denied = await runtime.dispatchFetch('https://mise.example.workers.dev/chat', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Fixture dinner',
          inventory: '',
          model: discoveredModel,
          modelReviewed: true,
        }),
      });
      assert.equal(
        denied.status,
        403,
        'Failed refresh must invalidate prior free-model authorization.',
      );
      assert.equal(calls.length, 4);
    },
  );
  passed++;
  await run(
    date,
    '/nutrition/status',
    undefined,
    () => assert.fail('Nutrition status must not consume USDA or Gemini quota.'),
    async (response, calls) => {
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { provider: 'usda', configured: true });
      assert.equal(calls.length, 0);
    },
  );
  passed++;
  for (const actualId of [true, false]) {
    await run(
      date,
      '/chat',
      groundedInput,
      async (request) => {
        assert.equal(new URL(request.url).hostname, 'generativelanguage.googleapis.com');
        const input = await request.json();
        assert.deepEqual(
          input.generationConfig.responseSchema.properties.recommendedRecipeIds.items.enum,
          ['actual-fixture'],
        );
        return geminiAnswer({
          message: 'Try the original chili.',
          recipes: [],
          warnings: [],
          recommendedRecipeIds: [actualId ? 'actual-fixture' : 'invented'],
        });
      },
      async (response, calls) => {
        assert.equal(response.status, actualId ? 200 : 502);
        const body = await response.json();
        if (actualId) {
          assert.deepEqual(body.recommendedRecipeIds, ['actual-fixture']);
          assert.deepEqual(body.recipes, []);
        } else assert.equal(body.error.code, 'invalid_response');
        assert.equal(calls.length, 1);
      },
    );
    passed++;
  }
  await run(
    date,
    '/health?model=gemini-3.8-flash',
    undefined,
    () => assert.fail('Choosing a supported model must not use Gemini quota.'),
    async (response, calls) => {
      assert.equal(response.status, 200);
      assert.equal((await response.json()).model, 'gemini-3.8-flash');
      assert.equal(calls.length, 0);
    },
  );
  passed++;
  await run(
    date,
    '/chat',
    {
      ...groundedInput,
      profile: 'Reviewed fixture report: BMR 1600 kcal.',
      model: 'gemini-3.1-flash-lite',
    },
    async (request) => {
      assert.equal(
        new URL(request.url).pathname,
        '/v1beta/models/gemini-3.1-flash-lite:generateContent',
      );
      const input = await request.json();
      assert.ok(input.contents.at(-1).parts[0].text.includes('selectedReviewedProfileReports'));
      assert.ok(input.systemInstruction.parts[0].text.includes('approvedDailyNutritionTargets'));
      assert.ok(input.systemInstruction.parts[0].text.includes('reviewed and attached a report'));
      assert.ok(input.systemInstruction.parts[0].text.includes('BMR'));
      return geminiAnswer({
        message: 'Try the original recipe.',
        recipes: [],
        warnings: [],
        recommendedRecipeIds: ['actual-fixture'],
      });
    },
    async (response, calls) => {
      assert.equal(response.status, 200);
      assert.equal(calls.length, 1);
    },
  );
  passed++;
  await run(
    date,
    '/chat',
    { message: 'Dinner', inventory: '', model: 'paid-pro' },
    () => assert.fail('Unsupported models must never reach Gemini.'),
    async (response, calls) => {
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, 'invalid_request');
      assert.equal(calls.length, 0);
    },
  );
  passed++;
  await run(
    date,
    '/chat',
    {
      message: 'Choose dinner using the reviewed fixture reports.',
      inventory: '食'.repeat(24000),
      profile: '体'.repeat(24000),
      history: Array.from({ length: 5 }, () => ({ role: 'user', text: '菜'.repeat(6000) })),
    },
    async (request) => {
      const input = await request.json();
      assert.ok(input.contents.at(-1).parts[0].text.includes('selectedReviewedProfileReports'));
      return geminiAnswer({
        message: 'What style of dinner would you like?',
        recipes: [],
        warnings: [],
      });
    },
    async (response, calls) => {
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
      assert.equal(calls.length, 1, 'Valid Unicode context above 128 KB must still reach Gemini.');
    },
  );
  passed++;
  await run(
    date,
    '/chat',
    {
      message: '\u0000'.repeat(6000),
      inventory: '\u0000'.repeat(24000),
      profile: '\u0000'.repeat(24000),
      recipe: '\u0000'.repeat(12000),
      history: Array.from({ length: 5 }, () => ({ role: 'user', text: '\u0000'.repeat(6000) })),
    },
    () => assert.fail('Aggregate oversized context must not reach Gemini.'),
    async (response, calls) => {
      assert.equal(response.status, 413);
      assert.equal((await response.json()).error.code, 'too_large');
      assert.equal(calls.length, 0);
    },
  );
  passed++;
  await run(
    date,
    '/profile/extract',
    { media: { mimeType: 'application/pdf', data: 'JVBERi0xLjQK' }, model: 'gemini-3.8-flash' },
    async (request) => {
      assert.equal(
        new URL(request.url).pathname,
        '/v1beta/models/gemini-3.8-flash:generateContent',
      );
      const input = await request.json();
      assert.deepEqual(input.contents[0].parts[1].inlineData, {
        mimeType: 'application/pdf',
        data: 'JVBERi0xLjQK',
      });
      assert.deepEqual(input.generationConfig.responseSchema.required, [
        'text',
        'recordedOn',
        'targets',
        'warnings',
        'readings',
      ]);
      assert.ok(input.systemInstruction.parts[0].text.includes('BMR is a measured report value'));
      return geminiAnswer({
        text: 'Fixture report: BMR 1600 kcal; recommended calories 2000–2200 kcal.',
        recordedOn: null,
        targets: { caloriesKcal: null, proteinGrams: null, carbsGrams: null, fatGrams: null },
        warnings: ['Recommended calories are a range.'],
        readings: [
          { label: 'BMR', value: '1600 kcal', kind: 'measurement' },
          { label: 'Calories', value: '2000–2200 kcal', kind: 'recommendation' },
        ],
      });
    },
    async (response, calls) => {
      assert.equal(response.status, 200);
      const report = await response.json();
      assert.equal(report.targets.caloriesKcal, null);
      assert.ok(report.text.includes('2000–2200 kcal'));
      assert.equal(report.readings[1].value, '2000–2200 kcal');
      assert.equal(calls.length, 1);
    },
  );
  passed++;
  await run(
    date,
    '/profile/extract',
    { media: { mimeType: 'video/mp4', data: 'AQID' } },
    () => assert.fail('A video cannot be uploaded as a profile report.'),
    async (response, calls) => {
      assert.equal(response.status, 400);
      assert.equal(calls.length, 0);
    },
  );
  passed++;
  await run(
    date,
    '/nutrition/extract',
    { text: 'Recommended daily intake: 2000 kcal, 120 g protein' },
    async (request) => {
      const input = await request.json();
      assert.deepEqual(input.generationConfig.responseSchema.required, [
        'targets',
        'sourceText',
        'warnings',
      ]);
      return geminiAnswer({
        targets: { caloriesKcal: 2000, proteinGrams: 120, carbsGrams: null, fatGrams: null },
        sourceText: 'Recommended daily intake: 2000 kcal, 120 g protein',
        warnings: ['Other targets not stated.'],
      });
    },
    async (response, calls) => {
      assert.equal(response.status, 200);
      assert.equal((await response.json()).targets.proteinGrams, 120);
      assert.equal(calls.length, 1);
    },
  );
  passed++;
  await run(
    date,
    '/nutrition/food',
    { fdcId: 12345 },
    (request) => {
      const url = new URL(request.url);
      assert.equal(url.hostname, 'api.nal.usda.gov');
      assert.equal(url.pathname, '/fdc/v1/food/12345');
      return json({
        fdcId: 12345,
        description: 'Runtime fixture beans',
        dataType: 'Foundation',
        foodNutrients: [
          { nutrient: { id: 1008, unitName: 'kcal' }, amount: 120 },
          { nutrient: { id: 1003, unitName: 'g' }, amount: 7 },
          { nutrient: { id: 1005, unitName: 'g' }, amount: 20 },
          { nutrient: { id: 1004, unitName: 'g' }, amount: 1 },
        ],
      });
    },
    async (response, calls) => {
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
      const body = await response.json();
      assert.equal(body.food.fdcId, 12345);
      assert.deepEqual(body.food.per100g, {
        caloriesKcal: 120,
        proteinGrams: 7,
        carbsGrams: 20,
        fatGrams: 1,
      });
      assert.equal(calls.length, 1);
    },
  );
  passed++;
  for (const provider of ['recipeapi', 'spoonacular']) {
    const input = { provider, query: 'chicken', limit: 1 };
    await run(
      date,
      '/recipes/search',
      input,
      (request) => {
        const url = new URL(request.url);
        assert.equal(
          url.hostname,
          provider === 'recipeapi' ? 'recipeapi.io' : 'api.spoonacular.com',
        );
        assert.equal(
          request.headers.get(provider === 'recipeapi' ? 'Authorization' : 'x-api-key'),
          provider === 'recipeapi'
            ? `Bearer ${bindings.RECIPEAPI_API_KEY}`
            : bindings.SPOONACULAR_API_KEY,
        );
        return json(provider === 'recipeapi' ? recipeApi : spoonacular);
      },
      async (response, calls) => {
        assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
        assert.equal(calls.length, 1);
        const body = await response.json();
        assert.equal(body.recipes.length, 1);
        assert.equal(body.recipes[0].ingredients[0].quantity, 300);
        assert.equal(body.storage, provider === 'spoonacular' ? 'session' : 'personal');
      },
    );
    passed++;
    await run(
      date,
      '/recipes/search',
      input,
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: 'https://untrusted.example/steal' },
        }),
      async (response, calls) => {
        assert.equal(response.status, 502);
        assert.equal((await response.json()).error.code, 'provider_redirect');
        assert.equal(calls.length, 1, 'Never forward credentials to a redirect destination.');
      },
    );
    passed++;
  }
  await run(
    date,
    '/recipes/search',
    { provider: 'recipeapi', query: 'chicken', limit: 1 },
    () => new Response(null, { status: 401 }),
    async (response, calls) => {
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error.code, 'provider_configuration');
      assert.equal(calls.length, 1);
    },
  );
  passed++;
  await run(
    date,
    '/import',
    { url: 'https://recipes.example.com/soup' },
    (request) => {
      const url = new URL(request.url);
      if (url.hostname === 'cloudflare-dns.com')
        return json({
          Status: 0,
          Answer: url.searchParams.get('type') === 'A' ? [{ type: 1, data: '93.184.216.34' }] : [],
        });
      assert.equal(url.hostname, 'recipes.example.com');
      const data = {
        '@type': 'Recipe',
        name: 'Runtime imported soup',
        recipeYield: '2 servings',
        recipeIngredient: ['300 g carrots'],
        recipeInstructions: ['Test-only: simmer.'],
      };
      return new Response(`<script type="application/ld+json">${JSON.stringify(data)}</script>`, {
        headers: { 'Content-Type': 'text/html' },
      });
    },
    async (response, calls) => {
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
      assert.equal(calls.length, 3, 'Verify both DNS address families before fetching HTML.');
      const body = await response.json();
      assert.equal(body.recipes[0].title, 'Runtime imported soup');
      assert.equal(body.recipes[0].ingredients[0].quantity, 300);
    },
  );
  passed++;
}
process.stdout.write(
  `${passed} Worker runtime checks passed across old and current compatibility dates.\n`,
);
