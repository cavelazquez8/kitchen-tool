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
