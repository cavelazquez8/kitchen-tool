export interface IngredientIdentitySuggestion {
  candidates: string[];
  confidence: 'clear' | 'review' | 'unknown';
  reason?: string;
}

export interface IngredientIdentityHints {
  brand?: string;
  genericName?: string;
  categories?: readonly string[];
}

const ALIASES: Record<string, string> = {
  courgette: 'zucchini',
  aubergine: 'eggplant',
  scallion: 'green onion',
  'spring onion': 'green onion',
  'garlic clove': 'garlic',
  'clove of garlic': 'garlic',
  'cloves of garlic': 'garlic',
  'plain flour': 'all purpose flour',
  'all purpose wheat flour': 'all purpose flour',
  'bicarbonate of soda': 'baking soda',
  'bicarb soda': 'baking soda',
  'caster sugar': 'superfine sugar',
  'icing sugar': 'powdered sugar',
  'white granulated sugar': 'sugar',
  'granulated sugar': 'sugar',
  'white sugar': 'sugar',
  'confectioners sugar': 'powdered sugar',
  'confectioner sugar': 'powdered sugar',
  'maize starch': 'cornstarch',
  'corn starch': 'cornstarch',
  'garbanzo bean': 'chickpea',
  groundnut: 'peanut',
  'groundnut oil': 'peanut oil',
  'rapeseed oil': 'canola oil',
  'minced beef': 'ground beef',
  'beef mince': 'ground beef',
  'minced pork': 'ground pork',
  'pork mince': 'ground pork',
  'minced turkey': 'ground turkey',
  'turkey mince': 'ground turkey',
  'minced chicken': 'ground chicken',
  'chicken mince': 'ground chicken',
  capsicum: 'bell pepper',
  'red capsicum': 'red bell pepper',
  'green capsicum': 'green bell pepper',
  'yellow capsicum': 'yellow bell pepper',
  'coriander leaf': 'cilantro',
  'coriander leaves': 'cilantro',
  'fresh coriander': 'cilantro',
  'coriander seed': 'coriander seed',
  'desiccated coconut': 'dried shredded coconut',
  'double cream': 'heavy cream',
  arugula: 'arugula',
  rocket: 'arugula',
  beetroot: 'beet',
  almondmilk: 'almond milk',
  oatmilk: 'oat milk',
  soymilk: 'soy milk',
  sultana: 'golden raisin',
};

// Only explicit noun forms: suffix stemming would confuse ingredients such as
// couscous, molasses, swiss cheese, and rice flour.
const PLURALS: Record<string, string> = {
  eggs: 'egg',
  tomatoes: 'tomato',
  potatoes: 'potato',
  onions: 'onion',
  carrots: 'carrot',
  bananas: 'banana',
  apples: 'apple',
  lemons: 'lemon',
  limes: 'lime',
  oranges: 'orange',
  cucumbers: 'cucumber',
  peppers: 'pepper',
  mushrooms: 'mushroom',
  strawberries: 'strawberry',
  blueberries: 'blueberry',
  raspberries: 'raspberry',
  blackberries: 'blackberry',
  avocados: 'avocado',
  courgettes: 'courgette',
  aubergines: 'aubergine',
  scallions: 'scallion',
  breasts: 'breast',
  thighs: 'thigh',
  wings: 'wing',
  drumsticks: 'drumstick',
  cloves: 'clove',
  beans: 'bean',
  chickpeas: 'chickpea',
  lentils: 'lentil',
  peas: 'pea',
  beets: 'beet',
  parsnips: 'parsnip',
  radishes: 'radish',
  peaches: 'peach',
  pears: 'pear',
  plums: 'plum',
  cherries: 'cherry',
  apricots: 'apricot',
  mangoes: 'mango',
  melons: 'melon',
  dates: 'date',
  almonds: 'almond',
  walnuts: 'walnut',
  peanuts: 'peanut',
  cashews: 'cashew',
  pecans: 'pecan',
  hazelnuts: 'hazelnut',
  raisins: 'raisin',
  sultanas: 'sultana',
  prawns: 'prawn',
  shrimps: 'shrimp',
  sausages: 'sausage',
  chops: 'chop',
  anchovies: 'anchovy',
  sardines: 'sardine',
  olives: 'olive',
  capers: 'caper',
  noodles: 'noodle',
  tortillas: 'tortilla',
  bagels: 'bagel',
  crackers: 'cracker',
  breadcrumbs: 'breadcrumb',
  seeds: 'seed',
  milks: 'milk',
  capsicums: 'capsicum',
  sauces: 'sauce',
  cheeses: 'cheese',
  sticks: 'stick',
  yolks: 'yolk',
  whites: 'white',
  leaves: 'leaf',
  oils: 'oil',
  broths: 'broth',
  flours: 'flour',
};

const PREPARATION =
  '(?:(?:finely|roughly|thinly|freshly|coarsely)\\s+)?(?:chopped|diced|sliced|minced|grated|peeled|washed|trimmed|rinsed|drained|juiced|beaten|melted|softened|heated|divided|seeded)';
const PREPARATION_SUFFIX = new RegExp(
  `,\\s*${PREPARATION}(?:\\s+(?:and\\s+)?${PREPARATION})*(?:,?\\s+divided)?$`,
  'i',
);
const PREPARATION_PREFIX = new RegExp(`^${PREPARATION}\\s+`, 'i');
const PRODUCE = new Set([
  'apple',
  'apricot',
  'avocado',
  'banana',
  'beet',
  'bell pepper',
  'red bell pepper',
  'green bell pepper',
  'yellow bell pepper',
  'blueberry',
  'broccoli',
  'cabbage',
  'carrot',
  'cauliflower',
  'celery',
  'cherry',
  'cucumber',
  'eggplant',
  'garlic',
  'ginger',
  'grape',
  'green bean',
  'green onion',
  'kale',
  'lemon',
  'lettuce',
  'lime',
  'mango',
  'mushroom',
  'onion',
  'orange',
  'parsnip',
  'pea',
  'peach',
  'pear',
  'pineapple',
  'plum',
  'potato',
  'pumpkin',
  'radish',
  'raspberry',
  'red onion',
  'spinach',
  'strawberry',
  'sweet potato',
  'tomato',
  'watermelon',
  'zucchini',
]);

function plainName(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, '')
    .replace(/[_–—-]/g, ' ')
    .replace(/[™®]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function nounAliases(value: string): string {
  const words = value.split(' ');
  const last = words.at(-1)!;
  if (PLURALS[last]) words[words.length - 1] = PLURALS[last];
  const singular = words.join(' ');
  return ALIASES[singular] ?? singular;
}

/** Exact ingredient identity, without guessing substitutions or preparation yields. */
export function canonicalIngredientName(value: string): string {
  let name = plainName(value)
    .replace(/(?:,?\s+to taste|,?\s+for (?:serving|garnish)|\s*\(optional\))$/, '')
    .replace(PREPARATION_SUFFIX, '')
    .replace(
      /\s*\((?:finely |roughly |thinly )?(?:chopped|diced|sliced|minced|grated|peeled|washed|trimmed|rinsed)\)$/,
      '',
    )
    .replace(/^of\s+/, '')
    .trim();
  // "Ground" and "crushed" are intentionally preserved: these can identify a
  // different cut/product (ground beef, crushed tomatoes), rather than a step.
  name = ALIASES[name] ?? name.replace(PREPARATION_PREFIX, '');
  name = nounAliases(name);
  const withoutMarketing = nounAliases(name.replace(/^(?:(?:organic|fresh)\s+)+/, ''));
  if (PRODUCE.has(withoutMarketing)) name = withoutMarketing;
  return name;
}

const KNOWN = new Set([
  ...PRODUCE,
  'egg',
  'milk',
  'whole milk',
  'skim milk',
  'low fat milk',
  'almond milk',
  'oat milk',
  'soy milk',
  'coconut milk',
  'butter',
  'unsalted butter',
  'salted butter',
  'heavy cream',
  'half and half',
  'sour cream',
  'plain yogurt',
  'greek yogurt',
  'cheddar cheese',
  'sharp cheddar cheese',
  'mozzarella cheese',
  'parmesan cheese',
  'cream cheese',
  'cottage cheese',
  'feta cheese',
  'chicken',
  'chicken breast',
  'chicken thigh',
  'chicken wing',
  'whole chicken',
  'ground chicken',
  'ground beef',
  'beef steak',
  'ground pork',
  'pork chop',
  'ground turkey',
  'turkey',
  'bacon',
  'ham',
  'sausage',
  'salmon',
  'tuna',
  'shrimp',
  'prawn',
  'cod',
  'tilapia',
  'black bean',
  'kidney bean',
  'pinto bean',
  'white bean',
  'chickpea',
  'lentil',
  'red lentil',
  'tofu',
  'tempeh',
  'rice',
  'white rice',
  'brown rice',
  'jasmine rice',
  'basmati rice',
  'quinoa',
  'couscous',
  'oats',
  'rolled oats',
  'steel cut oats',
  'pasta',
  'spaghetti',
  'macaroni',
  'egg noodle',
  'rice noodle',
  'bread',
  'white bread',
  'whole wheat bread',
  'tortilla',
  'bagel',
  'cracker',
  'breadcrumb',
  'flour',
  'all purpose flour',
  'bread flour',
  'whole wheat flour',
  'rice flour',
  'almond flour',
  'coconut flour',
  'cornstarch',
  'baking powder',
  'baking soda',
  'yeast',
  'sugar',
  'granulated sugar',
  'brown sugar',
  'superfine sugar',
  'powdered sugar',
  'honey',
  'maple syrup',
  'molasses',
  'cocoa powder',
  'vanilla extract',
  'olive oil',
  'extra virgin olive oil',
  'vegetable oil',
  'canola oil',
  'sesame oil',
  'peanut oil',
  'coconut oil',
  'vinegar',
  'white vinegar',
  'balsamic vinegar',
  'apple cider vinegar',
  'rice vinegar',
  'soy sauce',
  'fish sauce',
  'oyster sauce',
  'hot sauce',
  'worcestershire sauce',
  'ketchup',
  'mustard',
  'mayonnaise',
  'peanut butter',
  'jam',
  'tomato paste',
  'tomato sauce',
  'pasta sauce',
  'marinara sauce',
  'crushed tomato',
  'canned tomato',
  'chicken broth',
  'vegetable broth',
  'beef broth',
  'chicken stock',
  'vegetable stock',
  'beef stock',
  'salt',
  'kosher salt',
  'sea salt',
  'table salt',
  'black pepper',
  'white pepper',
  'paprika',
  'smoked paprika',
  'cumin',
  'chili powder',
  'cinnamon',
  'basil',
  'cilantro',
  'dill',
  'mint',
  'parsley',
  'rosemary',
  'thyme',
  'oregano',
  'dried oregano',
  'dried basil',
  'fresh basil',
  'fresh parsley',
  'garlic powder',
  'onion powder',
  'curry powder',
  'nutmeg',
  'coriander',
  'coriander seed',
  'cardamom',
  'turmeric',
  'almond',
  'walnut',
  'peanut',
  'cashew',
  'pecan',
  'hazelnut',
  'sunflower seed',
  'chia seed',
  'raisin',
  'golden raisin',
  'granola',
  'cereal',
  'popcorn',
  'potato chip',
  'pretzel',
  'cookie',
  'ice cream',
  'orange juice',
  'apple juice',
  'coffee',
  'tea',
  'water',
  'sparkling water',
]);

function identityLabel(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// Related forms are suggestions requiring review, never interchangeable stock.
// Plant milks, flour varieties, meat cuts, and cooked/canned forms are excluded.
const REVIEW_FAMILIES: readonly (readonly string[])[] = [
  ['milk', 'whole milk', 'skim milk', 'low fat milk', '1% milk', '2% milk', 'full fat milk'],
  [
    'rice',
    'white rice',
    'brown rice',
    'jasmine rice',
    'basmati rice',
    'long grain rice',
    'short grain rice',
    'arborio rice',
    'sushi rice',
  ],
  ...['basil', 'parsley', 'rosemary', 'thyme', 'oregano', 'dill', 'mint', 'cilantro'].map(
    (herb) => [herb, `fresh ${herb}`, `dried ${herb}`],
  ),
];

export function relatedIngredientNames(value: string): string[] {
  const name = canonicalIngredientName(value);
  return (
    REVIEW_FAMILIES.find((family) => family.includes(name))?.filter((item) => item !== name) ?? []
  );
}

function withoutBrand(name: string, brand?: string): string {
  let cleaned = plainName(name);
  for (const brandName of (brand ?? '').split(',').map(plainName).filter(Boolean)) {
    if (cleaned.startsWith(`${brandName} `)) cleaned = cleaned.slice(brandName.length).trim();
  }
  return cleaned
    .replace(/^(?:(?:organic|natural|premium)\s+)+/, '')
    .replace(/\s*\(?\d+(?:\.\d+)?\s*(?:g|kg|oz|lb|ml|l|fl oz)\)?$/, '')
    .trim();
}

/** Provider metadata suggests identity; only a user's saved choice is authoritative. */
export function suggestIngredientIdentity(
  name: string,
  hints: IngredientIdentityHints = {},
): IngredientIdentitySuggestion {
  const clean = canonicalIngredientName(withoutBrand(name, hints.brand));
  const generic = hints.genericName ? canonicalIngredientName(hints.genericName) : '';
  const direct = KNOWN.has(clean) ? clean : '';
  const genericKnown = KNOWN.has(generic) ? generic : '';
  if (direct && (!genericKnown || genericKnown === direct))
    return { candidates: [identityLabel(direct)], confidence: 'clear' };
  const candidates = new Set<string>();
  if (direct) candidates.add(direct);
  if (genericKnown) candidates.add(genericKnown);
  if (!direct) {
    // A substring is only a review candidate, never an automatic match. This
    // prevents almond milk, rice flour, and chicken-flavored soup being silently
    // treated as milk, flour, or chicken.
    const terms = [...KNOWN]
      .filter((term) => ` ${clean} `.includes(` ${term} `))
      .sort((a, b) => b.length - a.length);
    for (const term of terms) {
      if (![...candidates].some((existing) => ` ${existing} `.includes(` ${term} `)))
        candidates.add(term);
      if (candidates.size >= 4) break;
    }
  }
  for (const category of hints.categories ?? []) {
    const categoryName = canonicalIngredientName(category.replace(/^[a-z]{2}:/, ''));
    if (KNOWN.has(categoryName)) candidates.add(categoryName);
  }
  const labels = [...candidates].slice(0, 5).map(identityLabel);
  return labels.length
    ? {
        candidates: labels,
        confidence: 'review',
        reason:
          'Confirm the ingredient this product can supply. Its label or category is not an exact match.',
      }
    : {
        candidates: [],
        confidence: 'unknown',
        reason:
          'Choose an ingredient name for recipe matching, or keep this as a separate product.',
      };
}

/** Single explicit net mass/volume only. Multipacks and count-to-weight conversions require review. */
export function parsePackageQuantity(value: string): { quantity: number; unit: string } | null {
  const match = value
    .trim()
    .match(
      /^(\d+(?:\.\d+)?)\s*(kilograms?|kg|grams?|g|ounces?|oz|pounds?|lbs?|millilit(?:er|re)s?|ml|lit(?:er|re)s?|l|fluid ounces?|fl\s*oz)\.?$/i,
    );
  if (!match) return null;
  const quantity = Number(match[1]);
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  const unitText = match[2].toLowerCase().replace(/\s+/g, ' ');
  const unit = /^(?:kg|kilogram)/.test(unitText)
    ? 'kg'
    : /^(?:g|gram)/.test(unitText)
      ? 'g'
      : /^(?:ml|millilit)/.test(unitText)
        ? 'mL'
        : /^(?:l$|lit)/.test(unitText)
          ? 'L'
          : /^(?:lb|pound)/.test(unitText)
            ? 'lb'
            : /^(?:fl|fluid)/.test(unitText)
              ? 'fl oz'
              : 'oz';
  return { quantity, unit };
}
