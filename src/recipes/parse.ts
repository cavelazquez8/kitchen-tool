import type { Recipe, RecipeIngredient } from './types';
import { convertQuantity } from '../domain/inventory';

const FRACTIONS: Record<string, string> = {
  '¼': '1/4',
  '½': '1/2',
  '¾': '3/4',
  '⅓': '1/3',
  '⅔': '2/3',
  '⅛': '1/8',
  '⅜': '3/8',
  '⅝': '5/8',
  '⅞': '7/8',
  '⅕': '1/5',
  '⅖': '2/5',
  '⅗': '3/5',
  '⅘': '4/5',
  '⅙': '1/6',
  '⅚': '5/6',
};
const NUMBER = '(?:\\d+\\s+\\d+\\s*\\/\\s*\\d+|\\d+\\s*\\/\\s*\\d+|\\d+(?:\\.\\d+)?|\\.\\d+)';
// Named fields preserve their inferred types in the dashboard's generated JavaScript.
const UNITS = [
  { pattern: /^(?:fluid ounces?|fl\s*oz)\b/i, canonical: 'fl oz' },
  { pattern: /^T(?:\.|\b)\s*/, canonical: 'tbsp' },
  { pattern: /^t(?:\.|\b)\s*/, canonical: 'tsp' },
  { pattern: /^(?:tablespoons?|tblsp|tbsp|tbs)\b/i, canonical: 'tbsp' },
  { pattern: /^(?:teaspoons?|tsp)\b/i, canonical: 'tsp' },
  { pattern: /^(?:kilograms?|kg)\b/i, canonical: 'kg' },
  { pattern: /^(?:grams?|g)\b/i, canonical: 'g' },
  { pattern: /^(?:millilit(?:er|re)s?|ml)\b/i, canonical: 'mL' },
  { pattern: /^(?:decilit(?:er|re)s?|dl)\b/i, canonical: 'dL' },
  { pattern: /^(?:centilit(?:er|re)s?|cl)\b/i, canonical: 'cL' },
  { pattern: /^(?:lit(?:er|re)s?|l)\b/i, canonical: 'L' },
  { pattern: /^(?:ounces?|oz)\b/i, canonical: 'oz' },
  { pattern: /^(?:pounds?|lbs?)\b/i, canonical: 'lb' },
  { pattern: /^(?:cups?|c)\b/i, canonical: 'cup' },
  { pattern: /^(?:quarts?|qt)\b/i, canonical: 'qt' },
  { pattern: /^(?:gallons?|gal)\b/i, canonical: 'gal' },
  { pattern: /^(?:each|ea|items?|pieces?|counts?|ct)\b/i, canonical: 'each' },
  { pattern: /^sticks?\b/i, canonical: 'stick' },
  { pattern: /^packages?\b/i, canonical: 'package' },
  { pattern: /^cans?\b/i, canonical: 'can' },
  { pattern: /^bottles?\b/i, canonical: 'bottle' },
  { pattern: /^cartons?\b/i, canonical: 'carton' },
  { pattern: /^cloves?\b/i, canonical: 'clove' },
  { pattern: /^slices?\b/i, canonical: 'slice' },
  { pattern: /^pinch(?:es)?\b/i, canonical: 'pinch' },
  { pattern: /^bunch(?:es)?\b/i, canonical: 'bunch' },
  { pattern: /^sprigs?\b/i, canonical: 'sprig' },
];
function normalizeFractions(value: string): string {
  return value
    .replace(
      /[¼½¾⅓⅔⅛⅜⅝⅞⅕⅖⅗⅘⅙⅚]/g,
      (fraction, offset: number) =>
        `${offset > 0 && /\d/.test(value[offset - 1]) ? ' ' : ''}${FRACTIONS[fraction]}`,
    )
    .replace(/⁄/g, '/')
    .replace(/^(\d{1,3}(?:,\d{3})+)(?=\s|[a-z.]|$)/i, (number) => number.replace(/,/g, ''))
    .replace(/^(\d+),(\d{1,2})(?=\s|[a-z]|$)/i, '$1.$2')
    .trim();
}
function numberValue(value: string): number | null {
  value = value.replace(/\s*\/\s*/g, '/');
  const parts = value.trim().split(/\s+/);
  const fraction = parts.at(-1)!;
  if (!fraction.includes('/')) return Number(value);
  const [numerator, denominator] = fraction.split('/').map(Number);
  if (!denominator) return null;
  return (parts.length > 1 ? Number(parts[0]) : 0) + numerator / denominator;
}
interface ReadMeasure {
  quantity: number | null;
  unit: string;
  rest: string;
}
function readMeasure(value: string): ReadMeasure {
  const normalized = normalizeFractions(value);
  const range = normalized.match(new RegExp(`^(${NUMBER})\\s*(?:[-–—]|to)\\s*(${NUMBER})`, 'i'));
  const number = normalized.match(new RegExp(`^(${NUMBER})`));
  if (!number) return { quantity: null, unit: '', rest: normalized };
  const prefix = range ? range[0] : number[0];
  const rest = normalized.slice(prefix.length).trim();
  let unit = 'each';
  let remainder = rest;
  for (const { pattern, canonical } of UNITS) {
    const match = rest.match(pattern);
    if (!match) continue;
    unit = canonical;
    remainder = rest.slice(match[0].length).replace(/^\.?\s*/, '');
    break;
  }
  let quantity = range ? null : numberValue(number[0]);
  // Explicit alternative equivalents annotate the first measure; they never
  // imply a mass/volume conversion for inventory quantities.
  if (
    !['can', 'package', 'bottle', 'carton'].includes(unit) &&
    !/^\([^)]*\)\s*(?:cans?|packages?|bottles?|cartons?)\b/i.test(remainder)
  )
    remainder = remainder.replace(
      /^\(\s*\d+(?:\.\d+)?\s*(?:g|kg|oz|lb|ml|l|fl\s*oz)(?:\s*[/,;]\s*\d+(?:\.\d+)?\s*(?:g|kg|oz|lb|ml|l|fl\s*oz))*\s*\)\s*/i,
      '',
    );
  if (/^(?:plus|\+)\s*/i.test(remainder)) {
    const extra = readMeasure(remainder.replace(/^(?:plus|\+)\s*/i, ''));
    try {
      quantity =
        quantity === null || extra.quantity === null
          ? null
          : quantity + convertQuantity(extra.quantity, extra.unit, unit);
    } catch {
      quantity = null;
    }
    remainder = extra.rest;
  }
  return { quantity, unit, rest: remainder };
}

/** Keep ambiguous/ranged/package-size measures unknown rather than inventing an amount. */
export function parseMeasure(value: string): {
  quantity: number | null;
  unit: string;
  original: string;
} {
  const parsed = readMeasure(value);
  const preparation =
    /^(?:(?:finely|roughly|thinly|freshly|lightly|well)\s+)?(?:chopped|sliced|minced|diced|grated|crushed|softened|melted|drained|rinsed|beaten|divided|peeled|trimmed|washed)(?:\s+(?:and\s+)?(?:chopped|sliced|minced|diced|grated|crushed|peeled))*$/i;
  if (parsed.rest && !preparation.test(parsed.rest) && parsed.quantity !== null) {
    return {
      quantity: null,
      unit: parsed.unit === 'each' ? parsed.rest : parsed.unit,
      original: value.trim(),
    };
  }
  return { quantity: parsed.quantity, unit: parsed.unit, original: value.trim() };
}

export function parseIngredientLine(line: string): RecipeIngredient {
  const original = line.trim().replace(/^(?:[-*]\s+|•\s*)/, '');
  let parsed = readMeasure(original);
  // A can/package size is explicit source text, but not an inventory conversion.
  // Keep it for review instead of treating the first number as an item count.
  if (/^\([^)]*\)\s*(?:cans?|packages?|bottles?|cartons?)\b/i.test(parsed.rest)) {
    const remainder = parsed.rest.replace(/^\([^)]*\)\s*/, '');
    const packageMeasure = readMeasure(`1 ${remainder}`);
    parsed = { quantity: null, unit: packageMeasure.unit, rest: packageMeasure.rest };
  }
  if (parsed.unit === 'each' && /^(?:large|medium|small)\s+/i.test(parsed.rest)) {
    parsed = {
      ...parsed,
      quantity: null,
      rest: parsed.rest.replace(/^(?:large|medium|small)\s+/i, ''),
    };
  }
  // Approximate/heaped/scant amounts cannot support an exact shopping shortage.
  if (/^(?:about|approximately|approx\.?|roughly)\s+/i.test(original)) {
    parsed = {
      ...readMeasure(original.replace(/^(?:about|approximately|approx\.?|roughly)\s+/i, '')),
      quantity: null,
    };
  }
  if (/^(?:heaped|heaping|scant|generous|level)\s+/i.test(parsed.rest)) {
    const measure = readMeasure(
      `1 ${parsed.rest.replace(/^(?:heaped|heaping|scant|generous|level)\s+/i, '')}`,
    );
    parsed = { ...measure, quantity: null };
  }
  const name = (parsed.quantity !== null || parsed.unit ? parsed.rest : original)
    .replace(/^of\s+/i, '')
    .replace(
      /,\s*(?:(?:finely|roughly|thinly|freshly)\s+)?(?:chopped|sliced|minced|diced|grated|crushed|peeled|drained|rinsed)(?:\s+and\s+(?:chopped|sliced|minced|diced|grated|crushed|peeled))*$/i,
      '',
    )
    .replace(/(?:,?\s+to taste|,?\s+for (?:serving|frying)|\s*\(optional\))$/i, '')
    .trim();
  return {
    name: name || original,
    quantity: /\s+or\s+/i.test(name) || /^[−-]\d/.test(original) ? null : parsed.quantity,
    unit: parsed.unit,
    original,
    ...(/\boptional\b/i.test(original) ? { optional: true } : {}),
  };
}

/** Supports the editable text format used by copy/paste and the import form. */
export function parseRecipeText(input: string, id: string, sourceUrl?: string): Recipe {
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const title = (lines[0] ?? 'Untitled recipe').replace(/^#+\s*/, '');
  let mode: 'ingredients' | 'steps' | null = null;
  let servings: number | null = null;
  const ingredients: RecipeIngredient[] = [];
  const steps: string[] = [];
  for (const raw of lines.slice(1)) {
    const line = raw.replace(/^#+\s*/, '');
    const yieldMatch = line.match(/^(?:servings?|serves|yield)\s*:?\s*(\d+(?:\.\d+)?)$/i);
    if (yieldMatch) {
      const count = Number(yieldMatch[1]);
      servings = count > 0 ? count : null;
      continue;
    }
    if (/^ingredients?\s*:?$/i.test(line)) {
      mode = 'ingredients';
      continue;
    }
    if (/^(?:instructions?|directions?|method|steps)\s*:?$/i.test(line)) {
      mode = 'steps';
      continue;
    }
    if (mode === 'ingredients') ingredients.push(parseIngredientLine(line));
    if (mode === 'steps') steps.push(line.replace(/^\d+[.)]\s*/, ''));
  }
  return {
    id,
    title,
    servings,
    ingredients,
    steps,
    source: { type: 'imported', ...(sourceUrl?.trim() ? { url: sourceUrl.trim() } : {}) },
  };
}
