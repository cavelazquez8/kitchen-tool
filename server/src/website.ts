import { isRecord, parseAiReply } from '../../src/ai/protocol';
import type { AiReply, AiRecipeDraft } from '../../src/ai/protocol';
import { parseIngredientLine } from '../../src/recipes/parse';
import { copyRecipeMetadata, isRecipe } from '../../src/recipes/types';
import type { Recipe, RecipeMetadata, RecipePublisherNutrition } from '../../src/recipes/types';
import { workerOutboundOptions } from './outbound';

export class WebsiteImportError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 422,
  ) {
    super(message);
  }
}

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 15_000;

export function validateRecipeUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new WebsiteImportError('import_url', 'Enter a complete HTTPS recipe website link.', 400);
  }
  const host = url.hostname.toLowerCase();
  const blockedSuffixes = [
    '.localhost',
    '.local',
    '.internal',
    '.lan',
    '.home',
    '.test',
    '.invalid',
    '.example',
    '.workers.dev',
    '.nip.io',
    '.sslip.io',
  ];
  const blockedNames = [
    'localhost',
    'metadata.google.internal',
    'metadata.google.com',
    'instance-data.ec2.internal',
  ];
  if (
    input.length > 2000 ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ||
    blockedNames.includes(host) ||
    blockedSuffixes.some((suffix) => host.endsWith(suffix))
  ) {
    throw new WebsiteImportError(
      'import_url',
      'Use a public HTTPS recipe website, without a login, custom port, or local address.',
      400,
    );
  }
  url.hash = '';
  return url;
}

export function isPublicAddress(value: string): boolean {
  if (/^\d+(?:\.\d+){3}$/.test(value)) {
    const [a, b, c, d] = value.split('.').map(Number);
    if ([a, b, c, d].some((n) => n < 0 || n > 255)) return false;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && [0, 168].includes(b)) ||
      (a === 192 && b === 2) ||
      (a === 198 && [18, 19].includes(b)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (!/^[0-9a-f:]+$/i.test(value) || !value.includes(':')) return false;
  const prefix = parseInt(value.split(':')[0], 16);
  // Limit IPv6 to ordinary global unicast, excluding documentation/tunnelling ranges.
  return (
    prefix >= 0x2000 &&
    prefix <= 0x3fff &&
    !/^2001:(?:db8|0)(?::|$)/i.test(value) &&
    !/^2001::/i.test(value) &&
    !/^2002:/i.test(value)
  );
}

async function readText(response: Response, max: number): Promise<string> {
  const length = response.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > max))
    throw new WebsiteImportError(
      'import_size',
      'This recipe page is too large. Paste its recipe text instead.',
    );
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = '';
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > max) {
        await reader.cancel();
        throw new WebsiteImportError(
          'import_size',
          'This recipe page is too large. Paste its recipe text instead.',
        );
      }
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function checkPublicDns(
  host: string,
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<void> {
  let publicAddresses = 0;
  // Fetch does not expose the resolved address; recheck DNS for every redirect host.
  for (const type of ['A', 'AAAA']) {
    const response = await fetcher(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
      {
        ...workerOutboundOptions({ Accept: 'application/dns-json' }, signal),
        redirect: 'manual',
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new WebsiteImportError(
        'import_dns',
        'Could not verify this recipe website. Paste its recipe text instead.',
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(await readText(response, 64 * 1024));
    } catch {
      throw new WebsiteImportError(
        'import_dns',
        'Could not verify this recipe website. Paste its recipe text instead.',
      );
    }
    if (!isRecord(value) || value.Status !== 0)
      throw new WebsiteImportError(
        'import_dns',
        'This recipe website could not be reached. Check the link or paste its text.',
      );
    if (!Array.isArray(value.Answer)) continue;
    for (const record of value.Answer) {
      if (!isRecord(record) || ![1, 28].includes(Number(record.type))) continue;
      if (typeof record.data !== 'string' || !isPublicAddress(record.data))
        throw new WebsiteImportError(
          'import_url',
          'This link does not resolve to a supported public recipe website.',
          400,
        );
      publicAddresses++;
    }
  }
  if (!publicAddresses)
    throw new WebsiteImportError(
      'import_dns',
      'This recipe website has no supported public address. Paste its recipe text instead.',
    );
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    quot: '"',
    apos: "'",
    lt: '<',
    gt: '>',
    nbsp: ' ',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (_, entity: string) => {
    if (!entity.startsWith('#')) return named[entity.toLowerCase()] ?? '';
    const code = entity.toLowerCase().startsWith('#x')
      ? parseInt(entity.slice(2), 16)
      : parseInt(entity.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

export function plainRecipeText(value: string): string {
  return decodeEntities(value)
    .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)\s*>/gi, '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function schemaType(value: Record<string, unknown>, name: string): boolean {
  const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
  return types.some(
    (type) =>
      type === name ||
      (typeof type === 'string' && type.replace(/^https?:\/\/schema\.org\//, '') === name),
  );
}

function recipeNodes(value: unknown, result: Record<string, unknown>[], depth = 0): void {
  if (depth > 10 || result.length >= 24) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 200)) recipeNodes(item, result, depth + 1);
  } else if (isRecord(value)) {
    if (schemaType(value, 'Recipe')) result.push(value);
    for (const key of ['@graph', 'mainEntity', 'itemListElement', 'item']) {
      if (value[key] !== undefined) recipeNodes(value[key], result, depth + 1);
    }
  }
}

/** Resolve bounded JSON-LD @id references used for authors and instruction sections. */
function linkedData(value: unknown): unknown {
  const records = new Map<string, Record<string, unknown>>();
  let visited = 0;
  const collect = (entry: unknown, depth = 0): void => {
    if (depth > 14 || visited++ > 4000) return;
    if (Array.isArray(entry)) {
      for (const item of entry.slice(0, 200)) collect(item, depth + 1);
    } else if (isRecord(entry)) {
      if (typeof entry['@id'] === 'string') {
        const previous = records.get(entry['@id']);
        if (!previous || Object.keys(entry).length > Object.keys(previous).length)
          records.set(entry['@id'], entry);
      }
      for (const child of Object.values(entry)) collect(child, depth + 1);
    }
  };
  collect(value);
  visited = 0;
  const resolve = (entry: unknown, path: Set<string>, depth = 0): unknown => {
    if (depth > 14 || visited++ > 8000) return entry;
    if (Array.isArray(entry))
      return entry.slice(0, 200).map((item) => resolve(item, path, depth + 1));
    if (!isRecord(entry)) return entry;
    const id = typeof entry['@id'] === 'string' ? entry['@id'] : undefined;
    if (id && path.has(id)) return entry;
    const nextPath = new Set(path);
    if (id) nextPath.add(id);
    const combined = id ? { ...records.get(id), ...entry } : entry;
    return Object.fromEntries(
      Object.entries(combined).map(([key, child]) => [key, resolve(child, nextPath, depth + 1)]),
    );
  };
  return resolve(value, new Set());
}

function instructionSteps(value: unknown, depth = 0): string[] | null {
  if (depth > 10) return null;
  if (typeof value === 'string') {
    const text = plainRecipeText(value);
    return text ? [text] : null;
  }
  if (Array.isArray(value)) {
    if (!value.length || value.length > 60) return null;
    const result: string[] = [];
    for (const item of value) {
      const steps = instructionSteps(item, depth + 1);
      if (!steps) return null;
      result.push(...steps);
      if (result.length > 60) return null;
    }
    return result;
  }
  if (!isRecord(value)) return null;
  if (value.itemListElement !== undefined)
    return instructionSteps(value.itemListElement, depth + 1);
  if (value.item !== undefined) return instructionSteps(value.item, depth + 1);
  if (typeof value.text === 'string') return instructionSteps(value.text, depth + 1);
  return null;
}

function recipeServings(value: unknown): number | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const count = recipeServings(entry);
      if (count !== null) return count;
    }
    return null;
  }
  if (
    isRecord(value) &&
    typeof value.unitText === 'string' &&
    /^(?:servings?|people|persons?)$/i.test(value.unitText)
  )
    return recipeServings(`${String(value.value)} servings`);
  if (typeof value !== 'string') return null;
  const clean = plainRecipeText(value);
  const match =
    clean.match(/^(\d+(?:\.\d+)?)\s*(?:servings?|people|persons?)$/i) ??
    clean.match(/^(?:serves|servings?)\s*:?\s*(\d+(?:\.\d+)?)$/i);
  if (!match) return null;
  const count = Number(match[1]);
  return count > 0 && count <= 100 ? count : null;
}

/** A bare schema yield is usable only when the page explicitly labels that count as servings. */
function renderedRecipeServings(html: string, value: unknown): number | null {
  const yields = Array.isArray(value) ? value : [value];
  if (
    !yields.length ||
    !yields.every(
      (entry) =>
        (typeof entry === 'string' && /^\d+(?:\.\d+)?$/.test(entry.trim())) ||
        (typeof entry === 'number' && Number.isFinite(entry)),
    )
  )
    return null;
  const counts = new Set(yields.map(Number));
  if (counts.size !== 1) return null;
  const count = Number(yields[0]);
  if (count <= 0 || count > 100) return null;
  const span = /<span\b([^>]*)>([^<]{1,30})<\/span\s*>/gi;
  let match: RegExpExecArray | null;
  let visited = 0;
  while ((match = span.exec(html)) !== null && visited++ < 2000) {
    const attributes = match[1];
    const className = attributes.match(/\bclass\s*=\s*["']([^"']*)["']/i)?.[1];
    if (
      className?.split(/\s+/).includes('wprm-recipe-servings') &&
      /\baria-label\s*=\s*["']Adjust recipe servings["']/i.test(attributes) &&
      /^\d+(?:\.\d+)?$/.test(match[2].trim()) &&
      Number(match[2]) === count
    )
      return count;
  }
  return null;
}

function metadataText(value: unknown, limit = 180): string | undefined {
  if (Array.isArray(value)) {
    const values = value.map((entry) => metadataText(entry, limit)).filter(Boolean);
    const result = [...new Set(values)].join(', ');
    return result && result.length <= limit ? result : undefined;
  }
  if (isRecord(value)) return metadataText(value.name, limit);
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const result = plainRecipeText(String(value));
  return result && result.length <= limit ? result : undefined;
}

function metadataNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value.trim())) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

/** ISO 8601 durations only; prose durations are not interpreted or guessed. */
function durationMinutes(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = value.match(
    /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i,
  );
  if (!match || !match.slice(1).some((part) => part !== undefined)) return undefined;
  const minutes =
    Number(match[1] ?? 0) * 1440 +
    Number(match[2] ?? 0) * 60 +
    Number(match[3] ?? 0) +
    Number(match[4] ?? 0) / 60;
  return Number.isFinite(minutes) && minutes >= 0 && minutes <= 10080 ? minutes : undefined;
}

function publicImage(value: unknown, sourceUrl?: string): string | undefined {
  if (Array.isArray(value)) {
    for (const candidate of value.slice(0, 20)) {
      const image = publicImage(candidate, sourceUrl);
      if (image) return image;
    }
    return undefined;
  }
  if (isRecord(value)) return publicImage(value.contentUrl ?? value.url, sourceUrl);
  if (typeof value !== 'string' || value.length > 2000) return undefined;
  try {
    return validateRecipeUrl(new URL(value, sourceUrl).href).href;
  } catch {
    return undefined;
  }
}

function publisherMetadata(node: Record<string, unknown>, sourceUrl?: string): RecipeMetadata {
  const metadata: RecipeMetadata = {};
  const imageUrl = publicImage(node.image, sourceUrl);
  if (imageUrl) metadata.imageUrl = imageUrl;
  const author = metadataText(node.author);
  if (author) metadata.author = author;
  const category = metadataText(node.recipeCategory);
  if (category) metadata.category = category;
  const cuisine = metadataText(node.recipeCuisine);
  if (cuisine) metadata.cuisine = cuisine;
  for (const [field, property] of [
    ['prepMinutes', 'prepTime'],
    ['cookMinutes', 'cookTime'],
    ['totalMinutes', 'totalTime'],
  ] as const) {
    const minutes = durationMinutes(node[property]);
    if (minutes !== undefined) metadata[field] = minutes;
  }
  if (isRecord(node.aggregateRating)) {
    const value = metadataNumber(node.aggregateRating.ratingValue);
    const best = metadataNumber(node.aggregateRating.bestRating);
    const count = metadataNumber(
      node.aggregateRating.ratingCount ?? node.aggregateRating.reviewCount,
    );
    if (value !== undefined && (best === undefined || (best > 0 && value <= best)))
      metadata.rating = {
        value,
        ...(best === undefined ? {} : { best }),
        ...(count !== undefined && Number.isSafeInteger(count) ? { count } : {}),
      };
  }
  if (isRecord(node.nutrition)) {
    const nutrition: RecipePublisherNutrition = {};
    for (const [field, property] of [
      ['servingSize', 'servingSize'],
      ['calories', 'calories'],
      ['protein', 'proteinContent'],
      ['carbohydrates', 'carbohydrateContent'],
      ['fat', 'fatContent'],
      ['saturatedFat', 'saturatedFatContent'],
      ['fiber', 'fiberContent'],
      ['sugar', 'sugarContent'],
      ['sodium', 'sodiumContent'],
      ['cholesterol', 'cholesterolContent'],
    ] as const) {
      const text = metadataText(node.nutrition[property], 120);
      if (text) nutrition[field] = text;
    }
    if (Object.keys(nutrition).length) metadata.publisherNutrition = nutrition;
  }
  return metadata;
}

function comparableUrl(value: unknown, base?: string): string | undefined {
  if (isRecord(value)) return comparableUrl(value['@id'] ?? value.url, base);
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value, base);
    if (!['https:', 'http:'].includes(url.protocol)) return undefined;
    for (const key of [...url.searchParams.keys()])
      if (/^(?:utm_.+|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
    return `${url.hostname.replace(/^www\./, '')}${url.pathname.replace(/\/$/, '')}${url.search}`;
  } catch {
    return undefined;
  }
}

/** Small deterministic hash gives repeat imports stable IDs without retaining a crawl. */
function recipeIdentity(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function extractWebsiteRecipes(html: string, sourceUrl?: string): AiReply {
  const nodes: Record<string, unknown>[] = [];
  const script = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let match: RegExpExecArray | null;
  let count = 0;
  while ((match = script.exec(html)) !== null && count++ < 100 && nodes.length < 24) {
    if (
      !/\btype\s*=\s*(?:["']application\/ld\+json(?:\s*;[^"']*)?["']|application\/ld\+json(?:\s|$))/i.test(
        match[1],
      ) ||
      match[2].length > 512 * 1024
    )
      continue;
    try {
      recipeNodes(linkedData(JSON.parse(match[2])), nodes);
    } catch {
      try {
        recipeNodes(linkedData(JSON.parse(decodeEntities(match[2]))), nodes);
      } catch {
        /* Ignore malformed or unrelated structured data. */
      }
    }
  }
  const recipes: AiRecipeDraft[] = [];
  const warnings = new Set<string>();
  const seen = new Set<string>();
  for (const node of nodes) {
    if (typeof node.name !== 'string') continue;
    const nodeUrl = comparableUrl(node.url ?? node.mainEntityOfPage ?? node['@id'], sourceUrl);
    // Roundups often embed cards for other pages; never import one as this page's recipe.
    if (sourceUrl && nodeUrl && nodeUrl !== comparableUrl(sourceUrl)) continue;
    const ingredientLines = Array.isArray(node.recipeIngredient)
      ? node.recipeIngredient
      : typeof node.recipeIngredient === 'string'
        ? node.recipeIngredient.split(/\r?\n/)
        : [];
    const steps = instructionSteps(node.recipeInstructions);
    if (
      !ingredientLines.length ||
      ingredientLines.length > 60 ||
      !ingredientLines.every((line) => typeof line === 'string') ||
      !steps ||
      !steps.length ||
      steps.length > 60
    )
      continue;
    const ingredients = (ingredientLines as string[]).map((line) => {
      const parsed = parseIngredientLine(plainRecipeText(line));
      // Package sizes and alternatives need a person to choose an actual amount.
      if (/\d\s*\([^)]*\d|\b(?:or|about|approximately)\b/i.test(parsed.original ?? ''))
        parsed.quantity = null;
      return parsed;
    });
    const servings =
      recipeServings(node.recipeYield) ??
      (nodes.length === 1 ? renderedRecipeServings(html, node.recipeYield) : null);
    const title = plainRecipeText(node.name);
    const identity = JSON.stringify([title, ingredientLines, steps]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const metadata = publisherMetadata(node, sourceUrl);
    const source: Recipe['source'] | undefined = sourceUrl
      ? {
          type: 'imported',
          url: sourceUrl,
          name: new URL(sourceUrl).hostname.replace(/^www\./, ''),
          attribution: `${metadata.author ? `${metadata.author} · ` : ''}${new URL(sourceUrl).hostname.replace(/^www\./, '')}`,
        }
      : undefined;
    const parsed = parseAiReply({
      message: '',
      recipes: [{ title, servings, ingredients, steps }],
      warnings: [],
    });
    if (!parsed) continue;
    if (servings === null)
      warnings.add('Servings were not clearly stated. Set servings before scaling this recipe.');
    if (ingredients.some((ingredient) => ingredient.quantity === null))
      warnings.add(
        'Some ingredient amounts are missing or ambiguous. Review them before quantity matching.',
      );
    recipes.push({ ...parsed.recipes[0], ...metadata, ...(source ? { source } : {}) });
    if (recipes.length === 4) break;
  }
  const result: AiReply = {
    message:
      'Recipe imported from website data. Review ingredients, servings and steps before saving.',
    recipes,
    warnings: [...warnings],
  };
  if (!result.recipes.length)
    throw new WebsiteImportError(
      'import_no_recipe',
      'This page did not provide a complete readable recipe. Paste its ingredients and steps, or provide a screenshot/video for Gemini.',
    );
  return result;
}

export async function importRecipeWebsite(
  input: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<AiReply> {
  let url = validateRecipeUrl(input);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
      await checkPublicDns(url.hostname, fetcher, controller.signal);
      const response = await fetcher(url.href, {
        ...workerOutboundOptions(
          {
            Accept: 'text/html, application/xhtml+xml',
            'User-Agent': 'MiseRecipeImport/0.1',
          },
          controller.signal,
        ),
        method: 'GET',
        redirect: 'manual',
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('Location');
        if (response.body) await response.body.cancel();
        if (!location || redirect === MAX_REDIRECTS)
          throw new WebsiteImportError(
            'import_redirect',
            'This link redirects too many times. Use the final recipe website link or paste its text.',
          );
        url = validateRecipeUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok)
        throw new WebsiteImportError(
          'import_blocked',
          'This website could not be imported. Paste the recipe text or provide a screenshot/video instead.',
        );
      if (
        !/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(
          response.headers.get('Content-Type') ?? '',
        )
      )
        throw new WebsiteImportError(
          'import_type',
          'This link is not a recipe webpage. Paste recipe text or upload media instead.',
        );
      return extractWebsiteRecipes(await readText(response, MAX_HTML_BYTES), url.href);
    }
    throw new WebsiteImportError('import_redirect', 'Use the final recipe website link.');
  } catch (error) {
    if (error instanceof WebsiteImportError) throw error;
    if (controller.signal.aborted)
      throw new WebsiteImportError(
        'import_timeout',
        'This website took too long to respond. Paste its recipe text instead.',
        504,
      );
    throw new WebsiteImportError(
      'import_connection',
      'This recipe website could not be reached. Check the link or paste its text.',
      502,
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

/** Retrieve one complete publisher recipe, with provenance and no AI reconstruction. */
export async function fetchVerifiedPublisherRecipe(
  input: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Recipe> {
  const imported = await importRecipeWebsite(input, fetcher, signal);
  if (imported.recipes.length !== 1)
    throw new WebsiteImportError(
      'import_ambiguous',
      'This page contains several recipes. Open the individual recipe page to choose the correct one.',
    );
  const draft = imported.recipes[0];
  const source = draft.source;
  if (!source?.url)
    throw new WebsiteImportError('import_no_recipe', 'The recipe source could not be verified.');
  const recipe: Recipe = {
    id: `publisher:${recipeIdentity(comparableUrl(source.url) ?? source.url)}:${recipeIdentity(draft.title)}`,
    title: draft.title,
    servings: draft.servings,
    ingredients: draft.ingredients,
    steps: draft.steps,
    source,
    ...copyRecipeMetadata(draft),
  };
  if (!isRecipe(recipe))
    throw new WebsiteImportError('import_no_recipe', 'This recipe could not be read completely.');
  return recipe;
}
