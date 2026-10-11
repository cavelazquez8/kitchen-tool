export interface GeminiConnection {
  url: string;
  token: string;
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
}

export interface AiReply {
  message: string;
  recipes: AiRecipeDraft[];
  warnings: string[];
}

export interface AiChatRequest {
  message: string;
  inventory: string;
  tools?: string;
  recipe?: string;
  history?: AiMessage[];
}

export interface AiMedia {
  mimeType: string;
  data: string;
}

export interface AiExtractRequest {
  text?: string;
  sourceUrl?: string;
  media?: AiMedia;
}

export const MAX_MEDIA_BYTES = 1024 * 1024;
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
    !hasOnlyKeys(value, ['message', 'inventory', 'tools', 'recipe', 'history'])
  )
    return null;
  if (!text(value.message, 6000) || !text(value.inventory, 24000, true)) return null;
  if (value.tools !== undefined && !text(value.tools, 4000, true)) return null;
  if (value.recipe !== undefined && !text(value.recipe, 12000, true)) return null;
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
  return {
    message: value.message,
    inventory: value.inventory,
    ...(value.tools !== undefined ? { tools: value.tools as string } : {}),
    ...(value.recipe !== undefined ? { recipe: value.recipe as string } : {}),
    ...(history ? { history } : {}),
  };
}

export function parseExtractRequest(value: unknown): AiExtractRequest | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['text', 'sourceUrl', 'media'])) return null;
  if (value.text !== undefined && !text(value.text, 24000, true)) return null;
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
  };
}

function validNumber(value: unknown, max: number): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max)
  );
}

export function parseAiReply(value: unknown): AiReply | null {
  if (
    !isRecord(value) ||
    !text(value.message, 16000, true) ||
    !Array.isArray(value.recipes) ||
    value.recipes.length > 4
  )
    return null;
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
    recipes.push({
      title: recipe.title.trim(),
      servings: recipe.servings,
      ingredients,
      steps: recipe.steps as string[],
    });
  }
  return { message: value.message, recipes, warnings: value.warnings as string[] };
}

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
