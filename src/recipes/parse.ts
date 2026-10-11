import type { Recipe, RecipeIngredient } from './types';

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
};
const NUMBER = '(?:\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d+(?:\\.\\d+)?)';
// Named fields preserve their inferred types in the dashboard's generated JavaScript.
const UNITS = [
  { pattern: /^(?:fluid ounces?|fl\s*oz)\b/i, canonical: 'fl oz' },
  { pattern: /^(?:tablespoons?|tblsp|tbsp|tbs)\b/i, canonical: 'tbsp' },
  { pattern: /^(?:teaspoons?|tsp)\b/i, canonical: 'tsp' },
  { pattern: /^(?:kilograms?|kg)\b/i, canonical: 'kg' },
  { pattern: /^(?:grams?|g)\b/i, canonical: 'g' },
  { pattern: /^(?:millilit(?:er|re)s?|ml)\b/i, canonical: 'mL' },
  { pattern: /^(?:lit(?:er|re)s?|l)\b/i, canonical: 'L' },
  { pattern: /^(?:ounces?|oz)\b/i, canonical: 'oz' },
  { pattern: /^(?:pounds?|lbs?)\b/i, canonical: 'lb' },
  { pattern: /^cups?\b/i, canonical: 'cup' },
  { pattern: /^(?:each|items?|pieces?|counts?|ct)\b/i, canonical: 'each' },
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
      /[¼½¾⅓⅔⅛⅜⅝⅞]/g,
      (fraction, offset: number) =>
        `${offset > 0 && /\d/.test(value[offset - 1]) ? ' ' : ''}${FRACTIONS[fraction]}`,
    )
    .replace(/⁄/g, '/')
    .trim();
}
function numberValue(value: string): number | null {
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
  return { quantity: range ? null : numberValue(number[0]), unit, rest: remainder };
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
  const original = line.trim().replace(/^[-•*]\s*/, '');
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
  const name = (parsed.quantity !== null || parsed.unit ? parsed.rest : original)
    .replace(
      /,\s*(?:(?:finely|roughly|thinly|freshly)\s+)?(?:chopped|sliced|minced|diced|grated|crushed|peeled|drained|rinsed)(?:\s+and\s+(?:chopped|sliced|minced|diced|grated|crushed|peeled))*$/i,
      '',
    )
    .replace(/(?:,?\s+to taste|,?\s+for (?:serving|frying)|\s*\(optional\))$/i, '')
    .trim();
  return {
    name: name || original,
    quantity: parsed.quantity,
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
