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
const origin = 'https://mise-kitchen-cv8.expertroot3.chatgpt.site';
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
    await verify(response, calls);
  } finally {
    await runtime.dispose();
  }
}

let passed = 0;
for (const date of ['2024-10-01', '2026-10-10']) {
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
      assert.ok(
        input.systemInstruction.parts[0].text.includes('only approvedDailyNutritionTargets'),
      );
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
      ]);
      assert.ok(input.systemInstruction.parts[0].text.includes('BMR is a measured report value'));
      return geminiAnswer({
        text: 'Fixture report: BMR 1600 kcal; recommended calories 2000–2200 kcal.',
        recordedOn: null,
        targets: { caloriesKcal: null, proteinGrams: null, carbsGrams: null, fatGrams: null },
        warnings: ['Recommended calories are a range.'],
      });
    },
    async (response, calls) => {
      assert.equal(response.status, 200);
      const report = await response.json();
      assert.equal(report.targets.caloriesKcal, null);
      assert.ok(report.text.includes('2000–2200 kcal'));
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
