export interface RecipeIngredient {
  name: string;
  quantity: number | null;
  unit: string;
  original?: string;
  optional?: boolean;
}

/** Publisher-declared values retain their units and stated serving basis. */
export interface RecipePublisherNutrition {
  servingSize?: string;
  calories?: string;
  protein?: string;
  carbohydrates?: string;
  fat?: string;
  saturatedFat?: string;
  fiber?: string;
  sugar?: string;
  sodium?: string;
  cholesterol?: string;
}

export interface RecipeMetadata {
  imageUrl?: string;
  category?: string;
  cuisine?: string;
  author?: string;
  prepMinutes?: number;
  cookMinutes?: number;
  totalMinutes?: number;
  rating?: { value: number; count?: number; best?: number };
  publisherNutrition?: RecipePublisherNutrition;
}

export interface Recipe extends RecipeMetadata {
  id: string;
  title: string;
  servings: number | null;
  ingredients: RecipeIngredient[];
  steps: string[];
  source: {
    type: 'themealdb' | 'wikibooks' | 'imported' | 'ai' | 'manual';
    url?: string;
    name?: string;
    attribution?: string;
    license?: string;
    licenseUrl?: string;
  };
}

export interface RecipeSelection {
  recipe: Recipe;
  /** Target servings; scaling requires the source recipe's recorded yield. */
  servings?: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function amount(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}
function optionalUrl(value: unknown): boolean {
  if (value === undefined) return true;
  if (!text(value)) return false;
  try {
    const parsed = new URL(value);
    return ['https:', 'http:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}
function optionalText(value: unknown): boolean {
  return value === undefined || text(value);
}

const nutritionKeys = [
  'servingSize',
  'calories',
  'protein',
  'carbohydrates',
  'fat',
  'saturatedFat',
  'fiber',
  'sugar',
  'sodium',
  'cholesterol',
] as const;

function isRecipeMetadata(value: Record<string, unknown>): boolean {
  if (
    !optionalUrl(value.imageUrl) ||
    !optionalText(value.category) ||
    !optionalText(value.cuisine) ||
    !optionalText(value.author)
  )
    return false;
  for (const key of ['prepMinutes', 'cookMinutes', 'totalMinutes']) {
    const minutes = value[key];
    if (
      minutes !== undefined &&
      !(typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 0 && minutes <= 10080)
    )
      return false;
  }
  if (value.rating !== undefined) {
    const rating = value.rating;
    if (
      !record(rating) ||
      !(typeof rating.value === 'number' && Number.isFinite(rating.value) && rating.value >= 0) ||
      (rating.best !== undefined &&
        !(typeof rating.best === 'number' && Number.isFinite(rating.best) && rating.best > 0)) ||
      (typeof rating.best === 'number' && rating.value > rating.best) ||
      (rating.count !== undefined &&
        !(
          typeof rating.count === 'number' &&
          Number.isSafeInteger(rating.count) &&
          rating.count >= 0
        ))
    )
      return false;
  }
  if (value.publisherNutrition !== undefined) {
    if (!record(value.publisherNutrition)) return false;
    const nutrition = value.publisherNutrition;
    if (
      !nutritionKeys.some((key) => nutrition[key] !== undefined) ||
      !nutritionKeys.every(
        (key) =>
          nutrition[key] === undefined || (text(nutrition[key]) && nutrition[key].length <= 120),
      )
    )
      return false;
  }
  return true;
}

/** Explicit metadata allowlist for recipe drafts and transferable backups. */
export function copyRecipeMetadata(recipe: RecipeMetadata): RecipeMetadata {
  const publisherNutrition: RecipePublisherNutrition = {};
  for (const key of nutritionKeys) {
    const value = recipe.publisherNutrition?.[key];
    if (value !== undefined) publisherNutrition[key] = value;
  }
  return {
    ...(recipe.imageUrl === undefined ? {} : { imageUrl: recipe.imageUrl }),
    ...(recipe.category === undefined ? {} : { category: recipe.category }),
    ...(recipe.cuisine === undefined ? {} : { cuisine: recipe.cuisine }),
    ...(recipe.author === undefined ? {} : { author: recipe.author }),
    ...(recipe.prepMinutes === undefined ? {} : { prepMinutes: recipe.prepMinutes }),
    ...(recipe.cookMinutes === undefined ? {} : { cookMinutes: recipe.cookMinutes }),
    ...(recipe.totalMinutes === undefined ? {} : { totalMinutes: recipe.totalMinutes }),
    ...(recipe.rating === undefined
      ? {}
      : {
          rating: {
            value: recipe.rating.value,
            ...(recipe.rating.count === undefined ? {} : { count: recipe.rating.count }),
            ...(recipe.rating.best === undefined ? {} : { best: recipe.rating.best }),
          },
        }),
    ...(Object.keys(publisherNutrition).length === 0 ? {} : { publisherNutrition }),
  };
}

/** Validate imported/AI/backup recipes before accepting them into the personal library. */
export function isRecipe(value: unknown): value is Recipe {
  if (!record(value) || !text(value.id) || !text(value.title) || !amount(value.servings))
    return false;
  if (value.servings !== null && (value.servings as number) <= 0) return false;
  if (
    !Array.isArray(value.ingredients) ||
    value.ingredients.length === 0 ||
    value.ingredients.length > 200
  )
    return false;
  if (
    !Array.isArray(value.steps) ||
    value.steps.length === 0 ||
    value.steps.length > 200 ||
    !value.steps.every(text)
  )
    return false;
  for (const ingredient of value.ingredients) {
    if (
      !record(ingredient) ||
      !text(ingredient.name) ||
      !amount(ingredient.quantity) ||
      typeof ingredient.unit !== 'string' ||
      !optionalText(ingredient.original) ||
      !(ingredient.optional === undefined || typeof ingredient.optional === 'boolean')
    )
      return false;
  }
  if (
    !record(value.source) ||
    !['themealdb', 'wikibooks', 'imported', 'ai', 'manual'].includes(value.source.type as string) ||
    !optionalText(value.source.name) ||
    !optionalUrl(value.source.url) ||
    !optionalText(value.source.attribution) ||
    !optionalText(value.source.license) ||
    !optionalUrl(value.source.licenseUrl)
  )
    return false;
  return isRecipeMetadata(value);
}
