import { parseIngredientLine } from './parse';
import { isRecipe, type Recipe, type RecipeIngredient } from './types';

export interface WikibooksRecipePage {
  pageid: number;
  title: string;
  revid: number;
  wikitext: string;
}

export interface WikibooksRecipeResult {
  recipe: Recipe | null;
  reason?: string;
}

const LICENSE_URL = 'https://creativecommons.org/licenses/by-sa/4.0/';
const ATTRIBUTION = 'Wikibooks contributors · CC BY-SA 4.0; adapted for Mise.';
const INGREDIENT_HEADING = /^ingredients?$/i;
const STEP_HEADING =
  /^(?:procedures?|preparation|instructions?|directions?|method|process)(?:\s*\((?:brief|detailed)\))?$/i;
const END_HEADING =
  /^(?:equipment|utensils|notes(?:,.*)?|tips(?:,.*)?|variations?|references?|warnings?|see also)$/i;
const ENTITY: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  frac14: '¼',
  frac12: '½',
  frac34: '¾',
  deg: '°',
  ndash: '–',
  mdash: '—',
  times: '×',
  minus: '−',
  micro: 'µ',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  eacute: 'é',
  agrave: 'à',
  uuml: 'ü',
  ouml: 'ö',
  auml: 'ä',
};

/** Expand only templates whose source quantities/text can be retained without calculation. */
function templateText(content: string): string | null {
  const [rawName, ...parameters] = content.split('|').map((value) => value.trim());
  const name = rawName.toLowerCase().replace(/_/g, ' ');
  const values = parameters.filter((value) => !value.includes('='));
  if (name === 'cb' && values.length >= 1 && values.length <= 2) return values.at(-1)!;
  if (['g', 'kg', 'ml', 'mL', 'l'].includes(name) && values.length === 0) return rawName;
  if (
    ['cups', 'cup', 'tablespoons', 'teaspoons'].includes(name) &&
    values.length === 1 &&
    /^\d+(?:\.\d+)?$/.test(values[0])
  )
    return `${values[0]} ${name}`;
  if (name === '#invoke:temperature' && values.length === 2 && /^\d+(?:\.\d+)?$/.test(values[1])) {
    const unit = { c: '°C', f: '°F', gm: 'Gas Mark' }[values[0].toLowerCase()];
    return unit ? (unit === 'Gas Mark' ? `${unit} ${values[1]}` : `${values[1]} ${unit}`) : null;
  }
  if (name === 'convert/3' && values.length >= 6) {
    const numbers = [values[0], values[2], values[4]];
    if (
      numbers.every((value) => /^\d+(?:\.\d+)?$/.test(value)) &&
      ['x', '×'].includes(values[1]) &&
      ['x', '×'].includes(values[3]) &&
      /^[a-z]{1,5}$/i.test(values[5])
    )
      return `${numbers.join(' × ')} ${values[5]}`;
    return null;
  }
  if (['frac', 'fraction', 'sfrac'].includes(name)) {
    if (!values.every((value) => /^\d+$/.test(value))) return null;
    if (values.length === 1 && Number(values[0]) > 0) return `1/${values[0]}`;
    if (values.length === 2 && Number(values[1]) > 0) return `${values[0]}/${values[1]}`;
    if (values.length === 3 && Number(values[2]) > 0)
      return `${values[0]} ${values[1]}/${values[2]}`;
    return null;
  }
  if (['convert', 'cvt'].includes(name)) {
    const number = /^(?:-?\d+(?:\.\d+)?|\d+\/\d+|\d+ \d+\/\d+|[¼½¾⅓⅔⅛⅜⅝⅞])$/;
    if (!number.test(values[0] ?? '')) return null;
    const range = ['to', '-', '–', 'and', 'or'].includes(values[1]);
    if (range && !number.test(values[2] ?? '')) return null;
    const amount = range ? `${values[0]}–${values[2]}` : values[0];
    const rawUnit = values[range ? 3 : 1];
    if (!rawUnit || !/^[\w°µ% /-]{1,30}$/.test(rawUnit)) return null;
    const unit: Record<string, string> = {
      C: '°C',
      F: '°F',
      tbsp: 'tbsp',
      tsp: 'tsp',
      UScup: 'cup',
      USfloz: 'fl oz',
      impfloz: 'imperial fl oz',
    };
    return `${amount} ${unit[rawUnit] ?? rawUnit}`;
  }
  if (name === 'nowrap' && values.length === 1) return values[0];
  if (['!', 'pipe'].includes(name) && values.length === 0) return '|';
  return null;
}

/** Plain, readable source text; unresolved templates are rejected rather than dropped. */
export function cleanWikibooksText(source: string): string | null {
  let text = source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<ref\b[^>]*>[\s\S]*?<\/ref\s*>/gi, '')
    .replace(/<ref\b[^>]*\/\s*>/gi, '');
  for (let depth = 0; depth < 20 && text.includes('{{'); depth++) {
    let unresolved = false;
    const expanded = text.replace(/\{\{([^{}]*)\}\}/g, (_match, content: string) => {
      const replacement = templateText(content);
      if (replacement === null) unresolved = true;
      return replacement ?? '';
    });
    if (unresolved || expanded === text) return null;
    text = expanded;
  }
  if (/\{\{|\}\}|<\s*(?:math|syntaxhighlight|source)\b/i.test(text)) return null;
  text = text
    .replace(/\[\[(?:File|Image|Category):[^\]]*\]\]/gi, '')
    .replace(/\[\[([^[\]]+)\]\]/g, (_match, target: string) => {
      const pieces = target.split('|');
      return pieces.length > 1
        ? pieces.at(-1)!
        : pieces[0].replace(/^(?:Cookbook|w|wikipedia):/i, '');
    })
    .replace(/\[https?:\/\/[^\s\]]+\s+([^\]]+)\]/g, '$1')
    .replace(/\[https?:\/\/[^\]]+\]/g, '')
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<\/?(?:small|big|span|div|p|sup|sub|b|i|strong|em|u|nowiki)\b[^>]*>/gi, '')
    .replace(/'{2,5}/g, '')
    .replace(/&(#x[\da-f]+|#\d+|[a-z]\w*);/gi, (entity, code: string) => {
      if (!code.startsWith('#')) return ENTITY[code.toLowerCase()] ?? entity;
      const point = code.startsWith('#x')
        ? Number.parseInt(code.slice(2), 16)
        : Number.parseInt(code.slice(1), 10);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    })
    .replace(/\s+/g, ' ')
    .trim();
  if (/\[\[|\]\]|<\/?[a-z]|&[a-z]\w*;/i.test(text)) return null;
  return text;
}

interface Section {
  name: string;
  text: string;
}

function sections(wikitext: string): Section[] {
  const headings = [...wikitext.matchAll(/^(={2,6})\s*([^=\n]+?)\s*\1\s*$/gm)];
  return headings.map((heading, index) => {
    let end = wikitext.length;
    for (const next of headings.slice(index + 1)) {
      const currentIngredient = INGREDIENT_HEADING.test(heading[2].trim());
      const currentSteps = STEP_HEADING.test(heading[2].trim());
      const nextName = next[2].trim();
      if (
        next[1].length <= heading[1].length ||
        (currentIngredient && (STEP_HEADING.test(nextName) || END_HEADING.test(nextName))) ||
        (currentSteps && (INGREDIENT_HEADING.test(nextName) || END_HEADING.test(nextName)))
      ) {
        end = next.index!;
        break;
      }
    }
    return {
      name: heading[2].trim(),
      text: wikitext.slice(heading.index! + heading[0].length, end),
    };
  });
}

function servingsFromSource(wikitext: string): number | null {
  const summary = wikitext.match(/\{\{\s*recipe[ _]?summary\s*\|([\s\S]*?)\}\}/i)?.[1];
  const servings = summary?.match(/(?:^|\|)\s*servings\s*=\s*([^|]*)/i)?.[1].trim();
  if (!servings) return null;
  const plain = cleanWikibooksText(servings);
  // Yield in loaves, jars, cookies, or a range is not a recorded number of servings.
  if (!plain || !/^\d+(?:\.\d+)?(?:\s+(?:servings?|people|persons?))?$/i.test(plain)) return null;
  const amount = Number.parseFloat(plain);
  return Number.isFinite(amount) && amount > 0 && amount <= 1000 ? amount : null;
}

function categoryFromSource(wikitext: string): string | undefined {
  const raw = wikitext.match(/\|\s*category\s*=\s*([^|}\n]+)/i)?.[1];
  const category = raw ? cleanWikibooksText(raw) : null;
  const label = category
    ?.replace(/^recipes?\s+(?:(?:using|for)\s+)?/i, '')
    .replace(/\s+recipes?$/i, '')
    .trim();
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : undefined;
}

function cuisineFromSource(wikitext: string): string | undefined {
  const category = [...wikitext.matchAll(/\[\[Category:([^\]|]+) recipes(?:\|[^\]]*)?\]\]/gi)]
    .map((match) => match[1].trim())
    .find((name) =>
      /^(?:American|British|English|Scottish|Irish|French|Italian|Spanish|Portuguese|Greek|Turkish|German|Polish|Hungarian|Russian|Ukrainian|Swedish|Norwegian|Finnish|Danish|Mexican|Canadian|Brazilian|Argentinian|Peruvian|Colombian|Cuban|Puerto Rican|Jamaican|Chinese|Japanese|Korean|Vietnamese|Thai|Indian|Pakistani|Bangladeshi|Sri Lankan|Indonesian|Malaysian|Filipino|Lebanese|Syrian|Iranian|Israeli|Egyptian|Moroccan|Tunisian|Algerian|Nigerian|Ghanaian|Ethiopian|Kenyan|South African|Australian|New Zealand)$/i.test(
        name,
      ),
    );
  return category;
}

function ingredientFromSource(original: string): RecipeIngredient | null {
  let input = original.replace(/\btsps\b/gi, 'tsp').replace(/\btbsps\b/gi, 'tbsp');
  const approximation = /^(?:about|approximately|approx\.?|over|under|roughly|around)\s+/i;
  const afterAmount =
    /^([\d¼½¾⅓⅔⅛⅜⅝⅞][\d\s./¼½¾⅓⅔⅛⅜⅝⅞]*)\s+(?:heaped|heaping|rounded|scant|level-ish)\s+/i;
  const unclear = approximation.test(input) || afterAmount.test(input);
  input = input.replace(approximation, '').replace(afterAmount, '$1 ');
  let parsed = parseIngredientLine(input);
  if (unclear) parsed.quantity = null;
  if (/^(?:[+×]|x\s)/i.test(parsed.name)) {
    const rest = parseIngredientLine(parsed.name.replace(/^(?:[+×]|x\s)\s*/i, ''));
    if (rest.quantity !== null && rest.name !== parsed.name)
      parsed = { ...rest, quantity: null, unit: parsed.unit === 'each' ? rest.unit : parsed.unit };
    else parsed.quantity = null;
  }
  if (/^(?:cooking\s+spoons?|spoonfuls?|lumps?|knobs?|handfuls?|dashes?)\b/i.test(parsed.name))
    parsed.quantity = null;
  if (!parsed.name) return null;
  const amount =
    '(?:\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d+(?:\\.\\d+)?(?:\\s*[¼½¾⅓⅔⅛⅜⅝⅞])?|[¼½¾⅓⅔⅛⅜⅝⅞])';
  const unit =
    '(?:kilograms?|kg|grams?|g|millilit(?:er|re)s?|ml|decilit(?:er|re)s?|dl|lit(?:er|re)s?|l|pounds?|lbs?|fluid ounces?|fl\\s*oz|ounces?|oz|cups?|pints?|quarts?|tablespoons?|tbsp|teaspoons?|tsp|sticks?|ea\\.?|each|cans?|dashes?)';
  const measure = `${amount}(?:\\s*(?:[-–—]|to)\\s*${amount})?\\s*(?:(?:large|small)\\s+)?${unit}`;
  const alternativeMeasure = new RegExp(`^${measure}(?:\\s*(?:[/,;]|or)\\s*${measure})*$`, 'i');
  if (parsed.name === original && parsed.unit === 'clove')
    return { ...parsed, name: 'cloves', unit: 'each', original };
  const name = parsed.name
    .replace(/^\(([^)]*)\)\s*/, (match, inner: string) =>
      alternativeMeasure.test(inner.trim()) ? '' : match,
    )
    .replace(/^of\s+/i, '')
    .replace(
      /^(?:(?:finely|roughly|thinly|freshly)[ -]+)?(?:chopped|sliced|minced|diced|grated|crushed|peeled)\s+/i,
      '',
    )
    .replace(/^freshly[ -]ground\s+/i, '')
    .replace(/^(?:large|medium|small)(?:[ -]sized)?\s+/i, '')
    .replace(/^(?:warm|cold|hot)\s+(water)\b/i, '$1')
    .replace(/\s*\(or to taste\)\s*$/i, '')
    .trim();
  // Do not turn "X or Y" into an invented required quantity of either alternative.
  return name
    ? {
        ...parsed,
        name,
        original,
        ...(/\bor\b/i.test(name) || /\(or to taste\)/i.test(original) ? { quantity: null } : {}),
      }
    : null;
}

function fail(reason: string): WikibooksRecipeResult {
  return { recipe: null, reason };
}

/** Conservative build-time ingestion; unsupported source content never becomes a partial recipe. */
export function parseWikibooksRecipeResult(page: WikibooksRecipePage): WikibooksRecipeResult {
  if (
    !Number.isInteger(page.pageid) ||
    page.pageid <= 0 ||
    !Number.isInteger(page.revid) ||
    page.revid <= 0 ||
    !page.title.startsWith('Cookbook:') ||
    page.wikitext.length > 150_000
  )
    return fail('invalid source page');
  if (/^\s*#redirect\b|\{\{\s*(?:cookwork|incomplete|copyvio)\b/im.test(page.wikitext))
    return fail('redirect or unfinished source');
  const sourceSections = sections(page.wikitext.replace(/<!--[\s\S]*?-->/g, ''));
  const ingredientSections = sourceSections.filter((section) =>
    INGREDIENT_HEADING.test(section.name),
  );
  if (ingredientSections.length > 1)
    return fail('multiple ingredient sections require manual review');
  const ingredientsSection = ingredientSections[0];
  const stepsSection = sourceSections.find((section) => STEP_HEADING.test(section.name));
  if (!ingredientsSection || !stepsSection)
    return fail('missing ingredient or instruction section');
  if (ingredientsSection.text.includes('{|'))
    return fail('ingredient table requires manual review');
  const ingredients: RecipeIngredient[] = [];
  let optionalGroup = false;
  for (const raw of ingredientsSection.text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^<!--|^\[\[(?:Category|File|Image):|^__(?:NO)?TOC__|^<\/?div\b/i.test(line))
      continue;
    if (/^={2,6}/.test(line)) {
      optionalGroup = /\boptional\b/i.test(line);
      continue;
    }
    if (line.includes('{{') && !line.startsWith('*')) return fail('unresolved ingredient section');
    if (!line.startsWith('*')) {
      // Labels are harmless; free prose may contain required ingredients and must not disappear.
      if (
        /^'{2,3}[^']+'{2,3}$/.test(line) ||
        (/^[^.!?]+:$/.test(line) &&
          (!/\d|\byou\s+(?:need|will)|\buse\b/i.test(line) || /^(?:serves|for)\b/i.test(line)))
      )
        continue;
      return fail('non-list ingredient content requires manual review');
    }
    const plain = cleanWikibooksText(line.replace(/^\*+\s*/, ''));
    if (plain === null) return fail('unsupported ingredient markup');
    if (!plain || plain.endsWith(':')) continue;
    const ingredient = ingredientFromSource(plain);
    if (!ingredient) return fail('empty ingredient');
    ingredients.push(optionalGroup ? { ...ingredient, optional: true } : ingredient);
  }
  const steps: string[] = [];
  let group = '';
  for (const raw of stepsSection.text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^<!--|^\[\[Category:|^\{\{\s*DEFAULTSORT:|^\[\[[a-z]{2,3}:/i.test(line)) continue;
    const heading = line.match(/^={2,6}\s*([^=]+?)\s*={2,6}$/);
    if (heading) {
      const plain = cleanWikibooksText(heading[1]);
      if (plain === null) return fail('unsupported instruction heading');
      group = plain;
      continue;
    }
    const plain = cleanWikibooksText(line.replace(/^[#*]+\s*/, ''));
    if (plain === null) return fail('unsupported instruction markup');
    if (!plain) continue;
    if (/^[#*]/.test(line) || steps.length === 0) {
      steps.push(group ? `${group}: ${plain}` : plain);
      group = '';
    } else {
      steps[steps.length - 1] += ` ${plain}`;
    }
  }
  if (!ingredients.length || !steps.length) return fail('empty ingredients or instructions');
  const title = page.title.slice('Cookbook:'.length).trim();
  const category = categoryFromSource(page.wikitext);
  const cuisine = cuisineFromSource(page.wikitext);
  const recipe: Recipe = {
    id: `wikibooks:${page.pageid}`,
    title,
    servings: servingsFromSource(page.wikitext),
    ingredients,
    steps,
    source: {
      type: 'wikibooks',
      name: 'Wikibooks Cookbook',
      url: `https://en.wikibooks.org/w/index.php?oldid=${page.revid}`,
      attribution: ATTRIBUTION,
      license: 'CC BY-SA 4.0',
      licenseUrl: LICENSE_URL,
    },
    ...(category ? { category } : {}),
    ...(cuisine ? { cuisine } : {}),
  };
  return isRecipe(recipe) ? { recipe } : fail('invalid parsed recipe');
}

export function parseWikibooksRecipe(page: WikibooksRecipePage): Recipe | null {
  return parseWikibooksRecipeResult(page).recipe;
}
