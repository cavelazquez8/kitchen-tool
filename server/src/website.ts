import { isRecord, parseAiReply } from '../../src/ai/protocol';
import type { AiReply, AiRecipeDraft } from '../../src/ai/protocol';
import { parseIngredientLine } from '../../src/recipes/parse';
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

function recipeNodes(value: unknown, result: Record<string, unknown>[], depth = 0): void {
  if (depth > 8 || result.length >= 4) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 200)) recipeNodes(item, result, depth + 1);
  } else if (isRecord(value)) {
    const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
    if (
      types.some(
        (type) =>
          type === 'Recipe' ||
          (typeof type === 'string' && /^https?:\/\/schema\.org\/Recipe$/.test(type)),
      )
    )
      result.push(value);
    for (const key of ['@graph', 'mainEntity', 'itemListElement', 'item']) {
      if (value[key] !== undefined) recipeNodes(value[key], result, depth + 1);
    }
  }
}

function instructionSteps(value: unknown, depth = 0): string[] {
  if (depth > 8) return [];
  if (typeof value === 'string') return [plainRecipeText(value)].filter(Boolean);
  if (Array.isArray(value))
    return value.slice(0, 60).flatMap((item) => instructionSteps(item, depth + 1));
  if (!isRecord(value)) return [];
  if (value.itemListElement !== undefined)
    return instructionSteps(value.itemListElement, depth + 1);
  if (value.item !== undefined) return instructionSteps(value.item, depth + 1);
  if (typeof value.text === 'string') return instructionSteps(value.text, depth + 1);
  return [];
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

export function extractWebsiteRecipes(html: string): AiReply {
  const nodes: Record<string, unknown>[] = [];
  const script = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let match: RegExpExecArray | null;
  let count = 0;
  while ((match = script.exec(html)) !== null && count++ < 100 && nodes.length < 4) {
    if (
      !/\btype\s*=\s*(?:["']application\/ld\+json(?:\s*;[^"']*)?["']|application\/ld\+json(?:\s|$))/i.test(
        match[1],
      ) ||
      match[2].length > 512 * 1024
    )
      continue;
    try {
      recipeNodes(JSON.parse(match[2]), nodes);
    } catch {
      try {
        recipeNodes(JSON.parse(decodeEntities(match[2])), nodes);
      } catch {
        /* Ignore malformed or unrelated structured data. */
      }
    }
  }
  const recipes: AiRecipeDraft[] = [];
  const warnings = new Set<string>();
  for (const node of nodes) {
    if (typeof node.name !== 'string') continue;
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
    const servings = recipeServings(node.recipeYield);
    if (servings === null)
      warnings.add('Servings were not clearly stated. Set servings before scaling this recipe.');
    if (ingredients.some((ingredient) => ingredient.quantity === null))
      warnings.add(
        'Some ingredient amounts are missing or ambiguous. Review them before quantity matching.',
      );
    recipes.push({ title: plainRecipeText(node.name), servings, ingredients, steps });
  }
  const result = parseAiReply({
    message:
      'Recipe imported from website data. Review ingredients, servings and steps before saving.',
    recipes,
    warnings: [...warnings],
  });
  if (!result || !result.recipes.length)
    throw new WebsiteImportError(
      'import_no_recipe',
      'This page did not provide a complete readable recipe. Paste its ingredients and steps, or provide a screenshot/video for Gemini.',
    );
  return result;
}

export async function importRecipeWebsite(
  input: string,
  fetcher: typeof fetch = fetch,
): Promise<AiReply> {
  let url = validateRecipeUrl(input);
  const controller = new AbortController();
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
      return extractWebsiteRecipes(await readText(response, MAX_HTML_BYTES));
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
  }
}
