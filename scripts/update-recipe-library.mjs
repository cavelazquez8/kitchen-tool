import process from 'node:process';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Buffer } from 'node:buffer';
import { gzipSync } from 'node:zlib';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const api = 'https://en.wikibooks.org/w/api.php';
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith('--'))
    throw new Error(`${name} needs a path.`);
  return resolve(args[index + 1]);
};
const rawCache = option('--raw-cache');
const fromCache = option('--from-cache');
const output = resolve(root, 'public/data/wikibooks-recipes.json');
const reportPath = resolve(root, 'docs/wikibooks-ingestion-report.json');

async function request(parameters) {
  const url = new URL(api);
  for (const [key, value] of Object.entries({
    action: 'query',
    format: 'json',
    formatversion: '2',
    maxlag: '5',
    ...parameters,
  }))
    url.searchParams.set(key, String(value));
  for (let attempt = 0; attempt < 5; attempt++) {
    let pauseMs = 1000 * 2 ** attempt;
    try {
      const response = await globalThis.fetch(url, {
        headers: {
          'User-Agent':
            'MiseRecipeLibrary/1.0 (personal open cookbook; https://en.wikibooks.org/wiki/Cookbook:Recipes)',
          Accept: 'application/json',
        },
        signal: globalThis.AbortSignal.timeout(40_000),
      });
      const retryAfter = Number(response.headers.get('Retry-After'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) pauseMs = Math.min(retryAfter, 30) * 1000;
      if (!response.ok) throw new Error(`Wikibooks returned HTTP ${response.status}.`);
      const raw = await response.text();
      if (Buffer.byteLength(raw) > 8_000_000)
        throw new Error('Wikibooks response exceeded the size limit.');
      const data = JSON.parse(raw);
      if (data.error) throw new Error(`Wikibooks: ${data.error.code}: ${data.error.info}`);
      await delay(100); // Sequential requests and maxlag avoid imposing bursts on Wikimedia.
      return data;
    } catch (error) {
      if (attempt === 4) throw error;
      process.stderr.write(`Retrying Wikibooks request (${attempt + 1}/4): ${error.message}\n`);
      await delay(pauseMs);
    }
  }
  throw new Error('Wikibooks request failed.');
}

async function collectPages() {
  const titles = [];
  let continuation = {};
  for (let batch = 0; batch < 30; batch++) {
    const data = await request({
      list: 'categorymembers',
      cmtitle: 'Category:Recipes',
      cmnamespace: '102',
      cmtype: 'page',
      cmlimit: '500',
      ...continuation,
    });
    if (!Array.isArray(data.query?.categorymembers))
      throw new Error('Invalid recipe index response.');
    titles.push(...data.query.categorymembers);
    if (!data.continue) break;
    if (batch === 29) throw new Error('Recipe index exceeded the bounded pagination limit.');
    continuation = data.continue;
  }
  if (!titles.length || titles.length > 10_000) throw new Error('Unexpected recipe index size.');
  process.stdout.write(
    `Found ${titles.length} Cookbook recipe pages. Downloading current revisions.\n`,
  );
  const pages = [];
  for (let index = 0; index < titles.length; index += 50) {
    const batch = titles.slice(index, index + 50);
    const data = await request({
      pageids: batch.map((page) => page.pageid).join('|'),
      prop: 'revisions',
      rvprop: 'content|ids',
      rvslots: 'main',
    });
    if (!Array.isArray(data.query?.pages)) throw new Error('Invalid recipe revision response.');
    for (const page of data.query.pages) {
      const revision = page.revisions?.[0];
      const wikitext = revision?.slots?.main?.content;
      if (typeof wikitext !== 'string' || !Number.isInteger(revision.revid))
        throw new Error(
          `Missing revision for ${page.title}; leaving the previous library unchanged.`,
        );
      pages.push({ pageid: page.pageid, title: page.title, revid: revision.revid, wikitext });
    }
    if (index % 500 === 0 || index + 50 >= titles.length)
      process.stdout.write(`Downloaded ${pages.length}/${titles.length} pages.\n`);
  }
  if (pages.length !== titles.length) throw new Error('Recipe download was incomplete.');
  return { version: 1, downloadedAt: new Date().toISOString(), pages };
}

async function main() {
  const snapshot = fromCache ? JSON.parse(await readFile(fromCache, 'utf8')) : await collectPages();
  if (snapshot.version !== 1 || !Array.isArray(snapshot.pages) || !snapshot.pages.length)
    throw new Error('Invalid source snapshot.');
  if (rawCache && !fromCache) await writeFile(rawCache, JSON.stringify(snapshot));
  const server = await createServer({
    root,
    configFile: false,
    server: { middlewareMode: true },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  });
  try {
    const { parseWikibooksRecipeResult } = await server.ssrLoadModule('/src/recipes/wikibooks.ts');
    const recipes = [];
    const excluded = [];
    const ids = new Set();
    for (const page of snapshot.pages) {
      const { recipe, reason } = parseWikibooksRecipeResult(page);
      if (!recipe) {
        excluded.push({ title: page.title, reason });
        continue;
      }
      if (ids.has(recipe.id)) throw new Error(`Duplicate recipe page ID: ${recipe.id}`);
      ids.add(recipe.id);
      recipes.push(recipe);
    }
    recipes.sort((first, second) => first.title.localeCompare(second.title, 'en'));
    if (recipes.length < 500)
      throw new Error('Too few recipes passed validation; previous library left unchanged.');
    const excludedReasons = {};
    for (const page of excluded)
      excludedReasons[page.reason] = (excludedReasons[page.reason] ?? 0) + 1;
    const provenance = {
      pagesConsidered: snapshot.pages.length,
      recipesIncluded: recipes.length,
      recipesExcluded: excluded.length,
      excludedReasons,
    };
    const payload = {
      version: 1,
      generatedAt: snapshot.downloadedAt,
      source: {
        name: 'Wikibooks Cookbook',
        url: 'https://en.wikibooks.org/wiki/Cookbook:Recipes',
        license: 'CC BY-SA 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
        attribution:
          'Wikibooks contributors; ingredients and instructions adapted for Mise. Original quantities are retained and unsupported content is excluded.',
      },
      provenance,
      recipes,
    };
    const text = `${JSON.stringify(payload)}\n`;
    await mkdir(dirname(output), { recursive: true });
    await writeFile(`${output}.tmp`, text);
    await rename(`${output}.tmp`, output);
    await writeFile(
      reportPath,
      `${JSON.stringify({ generatedAt: payload.generatedAt, ...provenance, excluded }, null, 2)}\n`,
    );
    process.stdout.write(
      `${JSON.stringify({ ...provenance, bytes: Buffer.byteLength(text), gzipBytes: gzipSync(text).byteLength }, null, 2)}\n`,
    );
  } finally {
    await server.close();
  }
}

await main();
