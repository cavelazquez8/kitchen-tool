import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import console from 'node:console';
const sourceUrl = 'https://static.openfoodfacts.org/data/taxonomies/ingredients.json';
const input = process.argv[2];
const raw = input
  ? await readFile(input, 'utf8')
  : await (async () => {
      const response = await globalThis.fetch(sourceUrl, {
        headers: {
          'User-Agent':
            'MiseKitchen/1.0 (personal kitchen inventory; https://mise-kitchen-cv8.expertroot3.chatgpt.site)',
        },
        signal: globalThis.AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error(`Open Food Facts returned ${response.status}.`);
      const text = await response.text();
      if (Buffer.byteLength(text) > 15_000_000)
        throw new Error('Taxonomy exceeded the update limit.');
      return text;
    })();
const entries = Object.values(JSON.parse(raw));
const names = [
  ...new Set(
    entries
      .map((entry) => entry?.name?.en)
      .filter(
        (name) =>
          typeof name === 'string' &&
          name.length >= 2 &&
          name.length <= 120 &&
          !/[<>\r\n]/.test(name),
      )
      .map((name) => name.charAt(0).toLocaleUpperCase('en') + name.slice(1)),
  ),
].sort((a, b) => a.localeCompare(b, 'en'));
if (names.length < 1000 || names.length > 15000)
  throw new Error('Unexpected ingredient count; review the source before updating.');
const payload = {
  version: 1,
  generatedAt: new Date().toISOString(),
  source: {
    name: 'Open Food Facts ingredient taxonomy',
    url: sourceUrl,
    license: 'ODbL 1.0',
    licenseUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
    contentsLicense: 'Database Contents License 1.0',
    contentsLicenseUrl: 'https://opendatacommons.org/licenses/dbcl/1-0/',
    attribution:
      'Ingredient names adapted from Open Food Facts contributors. This name index is available under ODbL 1.0.',
    sha256: createHash('sha256').update(raw).digest('hex'),
  },
  names,
};
await writeFile(
  new URL('../public/data/food-ingredients.json', import.meta.url),
  JSON.stringify(payload) + '\n',
);
console.log(
  `Wrote ${names.length.toLocaleString('en')} ingredient names (${Buffer.byteLength(JSON.stringify(payload)).toLocaleString('en')} bytes).`,
);
