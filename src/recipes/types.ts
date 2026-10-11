export interface RecipeIngredient {
  name: string;
  quantity: number | null;
  unit: string;
  original?: string;
  optional?: boolean;
}

export interface Recipe {
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
  imageUrl?: string;
  category?: string;
  cuisine?: string;
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
  return optionalUrl(value.imageUrl) && optionalText(value.category) && optionalText(value.cuisine);
}
