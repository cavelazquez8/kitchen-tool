import type { InventoryState } from '../domain/types';
import { canonicalIngredientName } from './identity';
import { rankRecipes } from './matching';
import { canPersistProviderRecipe } from './providers';
import type { Recipe } from './types';

/** Discovery labels only; these do not assert allergens, nutrition, or cooking times. */
export const STARTER_RECIPES: readonly { id: string; tags: readonly string[] }[] = [
  { id: 'wikibooks:111890', tags: ['dinner', 'pasta', 'lasagna', 'beef'] },
  { id: 'wikibooks:462082', tags: ['dinner', 'chicken', 'grill', 'thai'] },
  { id: 'wikibooks:202116', tags: ['dinner', 'rice', 'beans'] },
  { id: 'wikibooks:385022', tags: ['dinner', 'breakfast', 'eggs', 'omelet', 'potatoes'] },
  { id: 'wikibooks:24663', tags: ['dinner', 'chicken', 'parmesan', 'italian'] },
  { id: 'wikibooks:452067', tags: ['dinner', 'pasta', 'spaghetti', 'spinach', 'mushroom'] },
  { id: 'wikibooks:14377', tags: ['dinner', 'chicken', 'pie'] },
  { id: 'wikibooks:112960', tags: ['lunch', 'salad', 'beans'] },
  { id: 'wikibooks:455492', tags: ['dinner', 'chicken', 'rice', 'sausage'] },
  { id: 'wikibooks:133096', tags: ['lunch', 'salad', 'pasta'] },
  { id: 'wikibooks:190711', tags: ['dinner', 'rice', 'lentils', 'pasta', 'egyptian'] },
  { id: 'wikibooks:4024', tags: ['dinner', 'chicken', 'grill', 'jamaican', 'jerk'] },
  { id: 'wikibooks:126780', tags: ['dinner', 'soup', 'chickpeas', 'coconut'] },
  { id: 'wikibooks:452081', tags: ['dinner', 'pasta', 'spaghetti', 'sausage'] },
  { id: 'wikibooks:457290', tags: ['dinner', 'chicken', 'roast'] },
  { id: 'wikibooks:156566', tags: ['dinner', 'pasta', 'spaghetti'] },
  { id: 'wikibooks:111783', tags: ['dinner', 'soup', 'beans'] },
  { id: 'wikibooks:29801', tags: ['lunch', 'breakfast', 'eggs', 'quiche'] },
  { id: 'wikibooks:127953', tags: ['dinner', 'beef', 'burgers', 'grill'] },
  { id: 'wikibooks:252226', tags: ['breakfast', 'eggs', 'salmon', 'burrito'] },
  { id: 'wikibooks:11375', tags: ['breakfast', 'grits'] },
  { id: 'wikibooks:194753', tags: ['breakfast', 'oats', 'oatmeal', 'porridge'] },
  { id: 'wikibooks:96176', tags: ['side', 'bread', 'cornbread'] },
  { id: 'wikibooks:96175', tags: ['side', 'bread', 'irish'] },
];

const starterMetadata = new Map(STARTER_RECIPES.map((entry) => [entry.id, entry]));
const starterOrder = new Map(STARTER_RECIPES.map((entry, index) => [entry.id, index]));

export function discoveryRecipePool(recipes: readonly Recipe[]): Recipe[] {
  const seen = new Set<string>();
  return recipes.filter((recipe) => {
    if (seen.has(recipe.id) || recipe.source.type === 'ai' || !canPersistProviderRecipe(recipe))
      return false;
    seen.add(recipe.id);
    return true;
  });
}

/** Keep the original source records, including attribution and unknown measures. */
export function getStarterRecipes(recipes: readonly Recipe[]): Recipe[] {
  const eligible = discoveryRecipePool(recipes);
  const byId = new Map(eligible.map((recipe) => [recipe.id, recipe]));
  const starters = STARTER_RECIPES.flatMap(({ id }) => {
    const recipe = byId.get(id);
    return recipe ? [recipe] : [];
  });
  // A custom/personal library can still be useful without the bundled collection.
  return starters.length > 0 ? starters : eligible.slice(0, STARTER_RECIPES.length);
}

/** Shuffle only source recipes, keeping original records and the caller's order intact. */
export function shuffleRecipeOrder(
  recipes: readonly Recipe[],
  random: () => number = Math.random,
): Recipe[] {
  const shuffled = discoveryRecipePool(recipes);
  for (let index = shuffled.length - 1; index > 0; index--) {
    const next = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[next]] = [shuffled[next], shuffled[index]];
  }
  return shuffled;
}

function normalize(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const requestWords = new Set([
  'a',
  'an',
  'and',
  'am',
  'ask',
  'are',
  'at',
  'be',
  'can',
  'cook',
  'cooking',
  'could',
  'choose',
  'familiar',
  'find',
  'for',
  'from',
  'give',
  'have',
  'help',
  'i',
  'id',
  'if',
  'ideas',
  'in',
  'is',
  'it',
  'like',
  'make',
  'me',
  'meal',
  'meals',
  'my',
  'need',
  'of',
  'or',
  'please',
  'question',
  'recipe',
  'recipes',
  'recommend',
  'some',
  'something',
  'suggest',
  'the',
  'to',
  'today',
  'tonight',
  'want',
  'what',
  'with',
  'would',
  'you',
]);

const excludedFamilies: Readonly<Record<string, readonly string[]>> = {
  dairy: ['milk', 'cheese', 'butter', 'cream', 'yogurt', 'yoghurt', 'ghee', 'whey'],
  nuts: ['peanut', 'almond', 'walnut', 'pecan', 'cashew', 'hazelnut', 'pistachio', 'macadamia'],
  meat: ['beef', 'chicken', 'pork', 'turkey', 'lamb', 'bacon', 'sausage', 'duck', 'venison'],
};

/** Narrow named-ingredient exclusions help discovery; they do not establish allergen safety. */
function requestParts(query: string): { positive: string; exclusions: string[] } {
  const exclusions: string[] = [];
  const positive = query.replace(
    /\b(?:without|no|avoid|exclude|allergic\s+to)\s+(.+?)(?=[.;!?]|\b(?:but|please|with|for)\b|$)/gi,
    (_whole, clause: string) => {
      for (const part of clause.split(/,|\band\b|\bor\b/gi)) {
        const ingredient = words(part)
          .filter((word) => !requestWords.has(word))
          .join(' ');
        if (ingredient) exclusions.push(canonicalIngredientName(ingredient));
      }
      return ' ';
    },
  );
  return { positive, exclusions: [...new Set(exclusions)] };
}

function excludesRecipe(recipe: Recipe, exclusions: readonly string[]): boolean {
  return exclusions.some((exclusion) => {
    const names = excludedFamilies[exclusion] ?? [exclusion];
    return recipe.ingredients.some((ingredient) => {
      const tokens = words(`${ingredient.name} ${canonicalIngredientName(ingredient.name)}`);
      return names.some((name) => words(name).every((term) => tokens.includes(term)));
    });
  });
}

function words(text: string): string[] {
  return normalize(text).split(' ').filter(Boolean);
}

function containsTerm(tokens: readonly string[], term: string): boolean {
  return tokens.some((word) => word === term || (term.length >= 3 && word.startsWith(term)));
}

interface SearchIndex {
  title: string;
  titleWords: string[];
  metadata: string[];
  labels: string[];
  ingredients: string[];
}

const searchIndexes = new WeakMap<Recipe, SearchIndex>();

function searchIndex(recipe: Recipe): SearchIndex {
  const existing = searchIndexes.get(recipe);
  if (existing) return existing;
  const title = normalize(recipe.title);
  const index: SearchIndex = {
    title,
    titleWords: words(title),
    metadata: words(`${recipe.category ?? ''} ${recipe.cuisine ?? ''}`),
    labels: words((starterMetadata.get(recipe.id)?.tags ?? []).join(' ')),
    ingredients: words(
      recipe.ingredients
        .map((ingredient) => `${ingredient.name} ${canonicalIngredientName(ingredient.name)}`)
        .join(' '),
    ),
  };
  searchIndexes.set(recipe, index);
  return index;
}

function requestScore(recipe: Recipe, terms: readonly string[], phrase: string): number {
  if (terms.length === 0) return 0;
  const index = searchIndex(recipe);
  let score = phrase.length > 0 && index.title.includes(phrase) ? 8 : 0;
  for (const term of terms) {
    if (containsTerm(index.titleWords, term)) score += 11;
    else if (containsTerm(index.metadata, term)) score += 7;
    else if (containsTerm(index.labels, term)) score += 6;
    else if (containsTerm(index.ingredients, term)) score += 5;
  }
  return score;
}

export interface RecommendationOptions {
  /** Discovery text; dietary safety and nutrition require separate confirmation. */
  query?: string;
  limit?: number;
  prioritizeExpiration?: boolean;
  today?: string;
  /** If positive keywords find nothing, keep named exclusions and offer starter dishes. */
  fallbackToStarters?: boolean;
}

/** Retrieve a small source-backed shortlist; inventory is a preference, never a requirement. */
export function recommendRecipes(
  recipes: readonly Recipe[],
  inventory: InventoryState,
  options: RecommendationOptions = {},
): Recipe[] {
  const requestedLimit = options.limit ?? 12;
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(60, Math.max(0, Math.floor(requestedLimit)))
    : 12;
  if (limit === 0) return [];
  const request = requestParts(options.query ?? '');
  const phrase = normalize(request.positive);
  const terms = [...new Set(words(phrase).filter((word) => !requestWords.has(word)))];
  const broadRequest =
    terms.length === 0 || terms.every((term) => ['dinner', 'lunch', 'breakfast'].includes(term));
  const eligible = discoveryRecipePool(recipes).filter(
    (recipe) => !excludesRecipe(recipe, request.exclusions),
  );
  let candidates = eligible
    .map((recipe) => ({ recipe, relevance: requestScore(recipe, terms, phrase) }))
    .filter(({ relevance }) => terms.length === 0 || relevance > 0);
  if (!candidates.length && options.fallbackToStarters)
    candidates = getStarterRecipes(eligible).map((recipe) => ({ recipe, relevance: 0 }));
  const prioritizeExpiration =
    options.prioritizeExpiration ?? /\b(?:expir\w*|use soon)\b/i.test(options.query ?? '');
  const relevanceById = new Map(candidates.map(({ recipe, relevance }) => [recipe.id, relevance]));
  const matches = rankRecipes(
    candidates.map(({ recipe }) => recipe),
    inventory,
    {
      today: options.today,
      prioritizeExpiration,
    },
  );
  const scored = matches.flatMap((match) => {
    const relevance = relevanceById.get(match.recipe.id) ?? 0;
    const count = Math.max(1, match.ingredients.length);
    const available = match.ingredients.filter((ingredient) => ingredient.status === 'available');
    const short = match.ingredients.filter((ingredient) => ingredient.status === 'short');
    const uncertain = match.ingredients.filter((ingredient) => ingredient.status === 'check');
    const stockScore = (available.length + short.length * 0.5 + uncertain.length * 0.25) / count;
    const qualityScore =
      (match.recipe.servings !== null ? 0.4 : 0) +
      (match.recipe.ingredients.every(
        (ingredient) => ingredient.optional || ingredient.quantity !== null,
      )
        ? 0.2
        : 0);
    const position = starterOrder.get(match.recipe.id);
    const starterScore =
      position === undefined ? 0 : 1.5 + (broadRequest ? 7 : 0) - position / 1000;
    return [
      {
        recipe: match.recipe,
        score:
          relevance +
          stockScore * 3 +
          qualityScore +
          starterScore +
          (prioritizeExpiration ? (match.useSoonCount / count) * 2 : 0),
      },
    ];
  });
  const sorted = scored.sort(
    (a, b) => b.score - a.score || a.recipe.title.localeCompare(b.recipe.title),
  );
  // Broad requests should offer several kinds of meal instead of twelve near-identical pastas.
  if (!broadRequest || limit < 4) return sorted.slice(0, limit).map(({ recipe }) => recipe);
  const familyCounts = new Map<string, number>();
  const selected: Recipe[] = [];
  const deferred: Recipe[] = [];
  const familyLimit = Math.max(2, Math.ceil(limit / 4));
  for (const { recipe } of sorted) {
    const tags = starterMetadata.get(recipe.id)?.tags ?? [];
    const family =
      ['pasta', 'rice', 'soup', 'salad', 'bread', 'chicken', 'beef', 'eggs'].find((tag) =>
        tags.includes(tag),
      ) ?? normalize(recipe.category ?? recipe.title);
    const count = familyCounts.get(family) ?? 0;
    if (count < familyLimit) {
      selected.push(recipe);
      familyCounts.set(family, count + 1);
    } else deferred.push(recipe);
  }
  return [...selected, ...deferred].slice(0, limit);
}
