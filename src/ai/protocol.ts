import { isRecipe } from '../recipes/types';
import type { Recipe } from '../recipes/types';

export interface GeminiConnection {
  url: string;
  token: string;
  model?: GeminiModel;
  modelReviewed?: true;
}

export interface AiMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface AiRecipeDraft {
  title: string;
  servings: number | null;
  ingredients: {
    name: string;
    quantity: number | null;
    unit: string;
    original?: string;
    optional?: boolean;
  }[];
  steps: string[];
  source?: Recipe['source'];
  imageUrl?: string;
  category?: string;
  cuisine?: string;
  author?: string;
  prepMinutes?: number;
  cookMinutes?: number;
  totalMinutes?: number;
  rating?: { value: number; count?: number; best?: number };
  publisherNutrition?: {
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
  };
}

export interface AiReply {
  message: string;
  recipes: AiRecipeDraft[];
  warnings: string[];
  recommendedRecipeIds?: string[];
  /** Complete publisher recipes retrieved and parsed by the Worker, never invented by Gemini. */
  sourceRecipes?: Recipe[];
}

/** A small, locally retrieved set of real recipes, never the whole cookbook. */
export interface AiRecipeCandidate {
  id: string;
  title: string;
  servings: number | null;
  ingredients: string[];
  missingIngredients: string[];
  source?: string;
  nutrition?: { perServing: NutritionValues; complete: boolean };
}

export interface AiNutritionReply {
  targets: NutritionTargets;
  sourceText: string;
  warnings: string[];
}

/** Proposed transcription for review, never automatically applied to a profile. */
export interface AiBodyScanReply {
  text: string;
  recordedOn: string | null;
  targets: NutritionTargets;
  warnings: string[];
  readings?: { label: string; value: string; kind: 'measurement' | 'recommendation' }[];
}

export interface AiChatRequest {
  message: string;
  inventory: string;
  tools?: string;
  recipe?: string;
  history?: AiMessage[];
  candidates?: AiRecipeCandidate[];
  nutritionTargets?: NutritionTargets;
  profile?: string;
  model?: GeminiModel;
  modelReviewed?: true;
  /** Give the assistant bounded publisher search/fetch tools instead of forcing recipe generation. */
  discover?: true;
}

export interface AiMedia {
  mimeType: string;
  data: string;
}

export interface AiExtractRequest {
  text?: string;
  sourceUrl?: string;
  media?: AiMedia;
  model?: GeminiModel;
  modelReviewed?: true;
}

export interface AiBodyScanExtractRequest {
  text?: string;
  media?: AiMedia;
  model?: GeminiModel;
  modelReviewed?: true;
}

export const MAX_BODY_SCAN_BYTES = 4_000_000;
export const BODY_SCAN_MEDIA_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export const MAX_MEDIA_BYTES = 1024 * 1024;
/** Shared UTF-8 JSON cap, including selected reports, inventory and recent conversation. */
export const MAX_CHAT_REQUEST_BYTES = 512 * 1024;
export const MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/webm',
] as const;
export const ALLOWED_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.8-flash',
] as const;
export const DEFAULT_MODEL = ALLOWED_MODELS[0];
export type GeminiModel = string;

export function isGeminiModel(value: unknown): value is GeminiModel {
  return typeof value === 'string' && (ALLOWED_MODELS as readonly string[]).includes(value);
}

/** Google resource IDs only, never arbitrary URL paths or query parameters. */
export function isGeminiModelId(value: unknown): value is GeminiModel {
  return (
    typeof value === 'string' &&
    value.length <= 100 &&
    /^gemini-[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value)
  );
}

/** Review records a user's choice; the Worker still verifies availability and free pricing. */
export function isSupportedModelSelection(model: unknown, reviewed: unknown): boolean {
  if (model === undefined) return reviewed === undefined;
  if (reviewed !== undefined && reviewed !== true) return false;
  return isGeminiModel(model) || (isGeminiModelId(model) && reviewed === true);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number, allowEmpty = false): value is string {
  return (
    typeof value === 'string' && value.length <= max && (allowEmpty || value.trim().length > 0)
  );
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

export function parseChatRequest(value: unknown): AiChatRequest | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'message',
      'inventory',
      'tools',
      'recipe',
      'history',
      'candidates',
      'nutritionTargets',
      'profile',
      'model',
      'modelReviewed',
      'discover',
    ])
  )
    return null;
  if (!text(value.message, 6000) || !text(value.inventory, 24000, true)) return null;
  if (value.tools !== undefined && !text(value.tools, 4000, true)) return null;
  if (value.recipe !== undefined && !text(value.recipe, 12000, true)) return null;
  if (value.profile !== undefined && !text(value.profile, 24000, true)) return null;
  if (!isSupportedModelSelection(value.model, value.modelReviewed)) return null;
  if (value.discover !== undefined && value.discover !== true) return null;
  if (value.nutritionTargets !== undefined && !isNutritionTargets(value.nutritionTargets))
    return null;
  let candidates: AiRecipeCandidate[] | undefined;
  if (value.candidates !== undefined) {
    if (
      !Array.isArray(value.candidates) ||
      value.candidates.length === 0 ||
      value.candidates.length > 12 ||
      JSON.stringify(value.candidates).length > 24000
    )
      return null;
    candidates = [];
    const ids = new Set<string>();
    for (const candidate of value.candidates) {
      if (
        !isRecord(candidate) ||
        !hasOnlyKeys(candidate, [
          'id',
          'title',
          'servings',
          'ingredients',
          'missingIngredients',
          'source',
          'nutrition',
        ]) ||
        !text(candidate.id, 200) ||
        ids.has(candidate.id) ||
        !text(candidate.title, 180) ||
        !validNumber(candidate.servings, 100) ||
        !Array.isArray(candidate.ingredients) ||
        candidate.ingredients.length === 0 ||
        candidate.ingredients.length > 60 ||
        !candidate.ingredients.every((item) => text(item, 400)) ||
        !Array.isArray(candidate.missingIngredients) ||
        candidate.missingIngredients.length > 60 ||
        !candidate.missingIngredients.every((item) => text(item, 400)) ||
        (candidate.source !== undefined && !text(candidate.source, 300))
      )
        return null;
      if (
        candidate.nutrition !== undefined &&
        (!isRecord(candidate.nutrition) ||
          !hasOnlyKeys(candidate.nutrition, ['perServing', 'complete']) ||
          !isNutritionValues(candidate.nutrition.perServing) ||
          typeof candidate.nutrition.complete !== 'boolean')
      )
        return null;
      ids.add(candidate.id);
      candidates.push(candidate as unknown as AiRecipeCandidate);
    }
  }
  let history: AiMessage[] | undefined;
  if (value.history !== undefined) {
    if (!Array.isArray(value.history) || value.history.length > 12) return null;
    history = [];
    for (const item of value.history) {
      if (
        !isRecord(item) ||
        !hasOnlyKeys(item, ['role', 'text']) ||
        !['user', 'assistant'].includes(String(item.role)) ||
        !text(item.text, 6000)
      )
        return null;
      history.push({ role: item.role as AiMessage['role'], text: item.text });
    }
    if (history.reduce((sum, item) => sum + item.text.length, 0) > 30000) return null;
  }
  const request: AiChatRequest = {
    message: value.message,
    inventory: value.inventory,
    ...(value.tools !== undefined ? { tools: value.tools as string } : {}),
    ...(value.recipe !== undefined ? { recipe: value.recipe as string } : {}),
    ...(value.profile !== undefined ? { profile: value.profile as string } : {}),
    ...(value.model !== undefined ? { model: value.model as GeminiModel } : {}),
    ...(value.modelReviewed === true ? { modelReviewed: true as const } : {}),
    ...(value.discover === true ? { discover: true as const } : {}),
    ...(history ? { history } : {}),
    ...(candidates ? { candidates } : {}),
    ...(value.nutritionTargets !== undefined
      ? { nutritionTargets: value.nutritionTargets as NutritionTargets }
      : {}),
  };
  return new TextEncoder().encode(JSON.stringify(request)).byteLength <= MAX_CHAT_REQUEST_BYTES
    ? request
    : null;
}

export function parseBodyScanExtractRequest(value: unknown): AiBodyScanExtractRequest | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['text', 'media', 'model', 'modelReviewed']))
    return null;
  if (value.text !== undefined && !text(value.text, 24000, true)) return null;
  if (!isSupportedModelSelection(value.model, value.modelReviewed)) return null;
  let media: AiMedia | undefined;
  if (value.media !== undefined) {
    if (!isRecord(value.media) || !hasOnlyKeys(value.media, ['mimeType', 'data'])) return null;
    const { mimeType, data } = value.media;
    if (
      typeof mimeType !== 'string' ||
      !(BODY_SCAN_MEDIA_TYPES as readonly string[]).includes(mimeType) ||
      typeof data !== 'string' ||
      !data.length ||
      data.length > Math.ceil(MAX_BODY_SCAN_BYTES / 3) * 4 ||
      data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
    )
      return null;
    const bytes = (data.length * 3) / 4 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
    if (bytes > MAX_BODY_SCAN_BYTES) return null;
    media = { mimeType, data };
  }
  if (!(typeof value.text === 'string' && value.text.trim()) && !media) return null;
  return {
    ...(value.text !== undefined ? { text: value.text as string } : {}),
    ...(media ? { media } : {}),
    ...(value.model !== undefined ? { model: value.model as GeminiModel } : {}),
    ...(value.modelReviewed === true ? { modelReviewed: true as const } : {}),
  };
}

export function parseAiBodyScanReply(value: unknown): AiBodyScanReply | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['text', 'recordedOn', 'targets', 'warnings', 'readings']) ||
    !text(value.text, 24000) ||
    !isNutritionTargets(value.targets) ||
    !Array.isArray(value.warnings) ||
    value.warnings.length > 12 ||
    !value.warnings.every((warning) => text(warning, 1000))
  )
    return null;
  if (
    value.readings !== undefined &&
    (!Array.isArray(value.readings) ||
      value.readings.length > 24 ||
      !value.readings.every(
        (reading) =>
          isRecord(reading) &&
          hasOnlyKeys(reading, ['label', 'value', 'kind']) &&
          text(reading.label, 100) &&
          text(reading.value, 160) &&
          ['measurement', 'recommendation'].includes(String(reading.kind)),
      ))
  )
    return null;
  if (value.recordedOn !== null) {
    if (typeof value.recordedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.recordedOn))
      return null;
    const date = new Date(`${value.recordedOn}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value.recordedOn)
      return null;
  }
  return {
    text: value.text,
    recordedOn: value.recordedOn,
    targets: value.targets,
    warnings: value.warnings as string[],
    ...(value.readings !== undefined
      ? { readings: value.readings as NonNullable<AiBodyScanReply['readings']> }
      : {}),
  };
}

export function parseExtractRequest(value: unknown): AiExtractRequest | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['text', 'sourceUrl', 'media', 'model', 'modelReviewed'])
  )
    return null;
  if (value.text !== undefined && !text(value.text, 24000, true)) return null;
  if (!isSupportedModelSelection(value.model, value.modelReviewed)) return null;
  if (value.sourceUrl !== undefined) {
    if (!text(value.sourceUrl, 2000)) return null;
    try {
      if (!['https:', 'http:'].includes(new URL(value.sourceUrl).protocol)) return null;
    } catch {
      return null;
    }
  }
  let media: AiMedia | undefined;
  if (value.media !== undefined) {
    if (!isRecord(value.media) || !hasOnlyKeys(value.media, ['mimeType', 'data'])) return null;
    const { mimeType, data } = value.media;
    if (
      typeof mimeType !== 'string' ||
      !(MEDIA_TYPES as readonly string[]).includes(mimeType) ||
      typeof data !== 'string'
    )
      return null;
    if (
      !data.length ||
      data.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4 ||
      data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
    )
      return null;
    const bytes = (data.length * 3) / 4 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
    if (bytes > MAX_MEDIA_BYTES) return null;
    media = { mimeType, data };
  }
  if (!(typeof value.text === 'string' && value.text.trim()) && !media) return null;
  return {
    ...(value.text !== undefined ? { text: value.text as string } : {}),
    ...(value.sourceUrl !== undefined ? { sourceUrl: value.sourceUrl as string } : {}),
    ...(media ? { media } : {}),
    ...(value.model !== undefined ? { model: value.model as GeminiModel } : {}),
    ...(value.modelReviewed === true ? { modelReviewed: true as const } : {}),
  };
}

function validNumber(value: unknown, max: number): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max)
  );
}

export function parseAiReply(
  value: unknown,
  candidates?: readonly AiRecipeCandidate[],
): AiReply | null {
  if (
    !isRecord(value) ||
    !text(value.message, 16000, true) ||
    !Array.isArray(value.recipes) ||
    value.recipes.length > 4
  )
    return null;
  let sourceRecipes: Recipe[] | undefined;
  if (value.sourceRecipes !== undefined) {
    if (
      !Array.isArray(value.sourceRecipes) ||
      value.sourceRecipes.length > 4 ||
      JSON.stringify(value.sourceRecipes).length > 160000 ||
      !value.sourceRecipes.every(
        (recipe) =>
          isRecipe(recipe) &&
          recipe.id.length <= 200 &&
          recipe.source.type === 'imported' &&
          recipe.source.url?.startsWith('https://'),
      ) ||
      new Set(value.sourceRecipes.map((recipe: Recipe) => recipe.id)).size !==
        value.sourceRecipes.length
    )
      return null;
    sourceRecipes = value.sourceRecipes as Recipe[];
  }
  let recommendedRecipeIds: string[] | undefined;
  if (value.recommendedRecipeIds !== undefined) {
    if (
      !Array.isArray(value.recommendedRecipeIds) ||
      value.recommendedRecipeIds.length > 3 ||
      !value.recommendedRecipeIds.every((id) => text(id, 200)) ||
      new Set(value.recommendedRecipeIds).size !== value.recommendedRecipeIds.length ||
      value.recommendedRecipeIds.some(
        (id) =>
          !candidates?.some((candidate) => candidate.id === id) &&
          !sourceRecipes?.some((recipe) => recipe.id === id),
      )
    )
      return null;
    recommendedRecipeIds = value.recommendedRecipeIds as string[];
  }
  // Grounded mode returns references to originals, never generated replacement recipes.
  if (candidates && (value.recipes.length !== 0 || !recommendedRecipeIds)) return null;
  if (
    !Array.isArray(value.warnings) ||
    value.warnings.length > 12 ||
    !value.warnings.every((item) => text(item, 1000))
  )
    return null;
  const recipes: AiRecipeDraft[] = [];
  for (const recipe of value.recipes) {
    if (!isRecord(recipe) || !text(recipe.title, 180) || !validNumber(recipe.servings, 100))
      return null;
    if (
      !Array.isArray(recipe.ingredients) ||
      recipe.ingredients.length === 0 ||
      recipe.ingredients.length > 60
    )
      return null;
    if (
      !Array.isArray(recipe.steps) ||
      recipe.steps.length === 0 ||
      recipe.steps.length > 60 ||
      !recipe.steps.every((step) => text(step, 3000))
    )
      return null;
    const ingredients: AiRecipeDraft['ingredients'] = [];
    for (const ingredient of recipe.ingredients) {
      if (
        !isRecord(ingredient) ||
        !text(ingredient.name, 160) ||
        !validNumber(ingredient.quantity, 100000) ||
        !text(ingredient.unit, 40, true)
      )
        return null;
      if (ingredient.original !== undefined && !text(ingredient.original, 400, true)) return null;
      if (ingredient.optional !== undefined && typeof ingredient.optional !== 'boolean')
        return null;
      ingredients.push({
        name: ingredient.name.trim(),
        quantity: ingredient.quantity,
        unit: ingredient.unit.trim(),
        ...(ingredient.original !== undefined ? { original: ingredient.original as string } : {}),
        ...(ingredient.optional !== undefined ? { optional: ingredient.optional as boolean } : {}),
      });
    }
    const draft: AiRecipeDraft = {
      title: recipe.title.trim(),
      servings: recipe.servings,
      ingredients,
      steps: recipe.steps as string[],
    };
    const metadataKeys = [
      'source',
      'imageUrl',
      'category',
      'cuisine',
      'author',
      'prepMinutes',
      'cookMinutes',
      'totalMinutes',
      'rating',
      'publisherNutrition',
    ] as const;
    for (const key of metadataKeys) {
      if (recipe[key] !== undefined) Object.assign(draft, { [key]: recipe[key] });
    }
    // Gemini's required original field may be empty when no source line exists.
    // Validate metadata against the normalized inventory shape without changing the draft.
    const validatedIngredients = draft.ingredients.map(({ original, ...ingredient }) =>
      original?.trim() ? { ...ingredient, original } : ingredient,
    );
    if (
      !isRecipe({
        ...draft,
        ingredients: validatedIngredients,
        id: 'review-draft',
        source: draft.source ?? { type: 'imported' },
      })
    )
      return null;
    recipes.push(draft);
  }
  return {
    message: value.message,
    recipes,
    warnings: value.warnings as string[],
    ...(recommendedRecipeIds ? { recommendedRecipeIds } : {}),
    ...(sourceRecipes ? { sourceRecipes } : {}),
  };
}

export function parseNutritionExtractRequest(value: unknown): AiExtractRequest | null {
  const input = parseExtractRequest(value);
  if (!input || input.sourceUrl || input.media?.mimeType.startsWith('video/')) return null;
  return input;
}

export function parseAiNutritionReply(value: unknown): AiNutritionReply | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['targets', 'sourceText', 'warnings']) ||
    !isNutritionTargets(value.targets) ||
    !text(value.sourceText, 12000, true) ||
    !Array.isArray(value.warnings) ||
    value.warnings.length > 12 ||
    !value.warnings.every((warning) => text(warning, 1000))
  )
    return null;
  return {
    targets: value.targets,
    sourceText: value.sourceText,
    warnings: value.warnings as string[],
  };
}

export const AI_NUTRITION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    targets: {
      type: 'OBJECT',
      properties: {
        caloriesKcal: { type: 'NUMBER', nullable: true },
        proteinGrams: { type: 'NUMBER', nullable: true },
        carbsGrams: { type: 'NUMBER', nullable: true },
        fatGrams: { type: 'NUMBER', nullable: true },
      },
      required: ['caloriesKcal', 'proteinGrams', 'carbsGrams', 'fatGrams'],
    },
    sourceText: { type: 'STRING' },
    warnings: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['targets', 'sourceText', 'warnings'],
} as const;

export const AI_BODY_SCAN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    text: { type: 'STRING' },
    recordedOn: { type: 'STRING', nullable: true },
    targets: AI_NUTRITION_SCHEMA.properties.targets,
    warnings: { type: 'ARRAY', items: { type: 'STRING' } },
    readings: {
      type: 'ARRAY',
      maxItems: 24,
      items: {
        type: 'OBJECT',
        properties: {
          label: { type: 'STRING' },
          value: { type: 'STRING' },
          kind: { type: 'STRING', enum: ['measurement', 'recommendation'] },
        },
        required: ['label', 'value', 'kind'],
      },
    },
  },
  required: ['text', 'recordedOn', 'targets', 'warnings', 'readings'],
} as const;

// The API uses its documented Schema representation; nullable values remain unknown.
export const AI_REPLY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    message: { type: 'STRING' },
    warnings: { type: 'ARRAY', items: { type: 'STRING' } },
    recipes: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING' },
          servings: { type: 'NUMBER', nullable: true },
          ingredients: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                name: { type: 'STRING' },
                quantity: { type: 'NUMBER', nullable: true },
                unit: { type: 'STRING' },
                original: { type: 'STRING' },
                optional: { type: 'BOOLEAN' },
              },
              required: ['name', 'quantity', 'unit', 'original', 'optional'],
            },
          },
          steps: { type: 'ARRAY', items: { type: 'STRING' } },
        },
        required: ['title', 'servings', 'ingredients', 'steps'],
      },
    },
  },
  required: ['message', 'recipes', 'warnings'],
} as const;
import { isNutritionTargets, isNutritionValues } from '../nutrition/types';
import type { NutritionTargets, NutritionValues } from '../nutrition/types';
