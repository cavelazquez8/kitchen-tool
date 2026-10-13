/** Values are never filled with zero when a source does not report a nutrient. */
export interface NutritionValues {
  caloriesKcal: number | null;
  proteinGrams: number | null;
  carbsGrams: number | null;
  fatGrams: number | null;
}

/** User-supplied daily goals. These are not calculated from body measurements. */
export type NutritionTargets = NutritionValues;

export const NUTRITION_KEYS = ['caloriesKcal', 'proteinGrams', 'carbsGrams', 'fatGrams'] as const;
export type NutritionKey = (typeof NUTRITION_KEYS)[number];

export const EMPTY_NUTRITION_TARGETS: NutritionTargets = {
  caloriesKcal: null,
  proteinGrams: null,
  carbsGrams: null,
  fatGrams: null,
};

export const USDA_DATA_TYPES = ['Foundation', 'SR Legacy', 'Survey (FNDDS)', 'Branded'] as const;
export type UsdaDataType = (typeof USDA_DATA_TYPES)[number];

export interface FoodNutrition {
  fdcId: number;
  description: string;
  dataType: UsdaDataType;
  sourceUrl: string;
  brand?: string;
  per100g: NutritionValues;
  /** Gram weights from this food's source record, never generic density guesses. */
  portions: { label: string; gramWeight: number }[];
}

export interface NutritionStatus {
  provider: 'usda';
  configured: boolean;
}

export interface NutritionSearchResults {
  query: string;
  foods: FoodNutrition[];
  rejectedCount: number;
}

export interface ConfirmedNutritionIngredient {
  ingredientIndex: number;
  food: FoodNutrition;
  /** Total edible grams used in the original, unscaled recipe. */
  grams: number;
  confirmed: true;
}

export interface RecipeNutritionMapping {
  /** Pins this mapping to the recorded ingredient list and yield. */
  recipeKey: string;
  ingredients: ConfirmedNutritionIngredient[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function amount(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

export function isNutritionValues(value: unknown): value is NutritionValues {
  return (
    record(value) &&
    onlyKeys(value, NUTRITION_KEYS) &&
    NUTRITION_KEYS.every((key) => value[key] === null || amount(value[key], 100_000))
  );
}

export function isNutritionTargets(value: unknown): value is NutritionTargets {
  return isNutritionValues(value) && (value.caloriesKcal === null || value.caloriesKcal > 0);
}

export function copyNutritionValues(value: NutritionValues): NutritionValues {
  return {
    caloriesKcal: value.caloriesKcal,
    proteinGrams: value.proteinGrams,
    carbsGrams: value.carbsGrams,
    fatGrams: value.fatGrams,
  };
}

export function isFoodNutrition(value: unknown): value is FoodNutrition {
  if (
    !record(value) ||
    !onlyKeys(value, [
      'fdcId',
      'description',
      'dataType',
      'sourceUrl',
      'brand',
      'per100g',
      'portions',
    ]) ||
    !Number.isSafeInteger(value.fdcId) ||
    (value.fdcId as number) <= 0 ||
    !text(value.description, 600) ||
    !USDA_DATA_TYPES.includes(value.dataType as UsdaDataType) ||
    value.sourceUrl !== `https://fdc.nal.usda.gov/food-details/${value.fdcId}/nutrients` ||
    !(value.brand === undefined || text(value.brand, 300)) ||
    !isNutritionValues(value.per100g) ||
    !Array.isArray(value.portions) ||
    value.portions.length > 30
  )
    return false;
  return value.portions.every(
    (portion) =>
      record(portion) &&
      onlyKeys(portion, ['label', 'gramWeight']) &&
      text(portion.label, 300) &&
      amount(portion.gramWeight, 1_000_000) &&
      portion.gramWeight > 0,
  );
}

export function copyFoodNutrition(value: FoodNutrition): FoodNutrition {
  return {
    fdcId: value.fdcId,
    description: value.description,
    dataType: value.dataType,
    sourceUrl: value.sourceUrl,
    ...(value.brand ? { brand: value.brand } : {}),
    per100g: copyNutritionValues(value.per100g),
    portions: value.portions.map(({ label, gramWeight }) => ({ label, gramWeight })),
  };
}

export function isRecipeNutritionMapping(value: unknown): value is RecipeNutritionMapping {
  if (
    !record(value) ||
    !onlyKeys(value, ['recipeKey', 'ingredients']) ||
    !text(value.recipeKey, 100_000) ||
    !Array.isArray(value.ingredients) ||
    value.ingredients.length > 200
  )
    return false;
  const seen = new Set<number>();
  for (const ingredient of value.ingredients) {
    if (
      !record(ingredient) ||
      !onlyKeys(ingredient, ['ingredientIndex', 'food', 'grams', 'confirmed']) ||
      !Number.isInteger(ingredient.ingredientIndex) ||
      (ingredient.ingredientIndex as number) < 0 ||
      (ingredient.ingredientIndex as number) >= 200 ||
      !isFoodNutrition(ingredient.food) ||
      !amount(ingredient.grams, 1_000_000) ||
      ingredient.confirmed !== true ||
      seen.has(ingredient.ingredientIndex as number)
    )
      return false;
    seen.add(ingredient.ingredientIndex as number);
  }
  return true;
}

export function copyRecipeNutritionMapping(value: RecipeNutritionMapping): RecipeNutritionMapping {
  return {
    recipeKey: value.recipeKey,
    ingredients: value.ingredients.map(({ ingredientIndex, food, grams }) => ({
      ingredientIndex,
      food: copyFoodNutrition(food),
      grams,
      confirmed: true,
    })),
  };
}

export function parseNutritionStatus(value: unknown): NutritionStatus | null {
  return record(value) && value.provider === 'usda' && typeof value.configured === 'boolean'
    ? { provider: 'usda', configured: value.configured }
    : null;
}

export function parseNutritionSearchResults(value: unknown): NutritionSearchResults | null {
  if (
    !record(value) ||
    !text(value.query, 120) ||
    !Array.isArray(value.foods) ||
    value.foods.length > 10 ||
    !value.foods.every(isFoodNutrition) ||
    !Number.isInteger(value.rejectedCount) ||
    (value.rejectedCount as number) < 0 ||
    (value.rejectedCount as number) > 10
  )
    return null;
  return {
    query: value.query,
    foods: value.foods.map(copyFoodNutrition),
    rejectedCount: value.rejectedCount as number,
  };
}
