import {
  RECIPE_PROVIDER_INFO,
  recipeApiToRecipe,
  spoonacularToRecipe,
  type RecipeProviderId,
  type RecipeProviderResults,
  type RecipeProviderSearch,
  type RecipeProviderStatus,
} from '../../src/recipes/providers';
import { isRecord } from '../../src/ai/protocol';
import type { Recipe } from '../../src/recipes/types';

export interface RecipeProviderEnv {
  RECIPEAPI_API_KEY?: string;
  RECIPEAPI_PLAN?: string;
  SPOONACULAR_API_KEY?: string;
  SPOONACULAR_PLAN?: string;
}

interface ProviderCounter {
  month: string;
  monthlyRequests: number;
  day: number;
  dailyPoints: number;
  minuteStart: number;
  minuteRequests: number;
  lastRequest: number;
  inFlight: boolean;
  pausedUntil: number;
}

export type RecipeProviderState = Record<RecipeProviderId, ProviderCounter>;

export class RecipeProviderError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'RecipeProviderError';
  }
}

export function createRecipeProviderState(): RecipeProviderState {
  const empty = (): ProviderCounter => ({
    month: '',
    monthlyRequests: 0,
    day: 0,
    dailyPoints: 0,
    minuteStart: 0,
    minuteRequests: 0,
    lastRequest: 0,
    inFlight: false,
    pausedUntil: 0,
  });
  return { recipeapi: empty(), spoonacular: empty() };
}

function key(env: RecipeProviderEnv, provider: RecipeProviderId): string | null {
  const value = provider === 'recipeapi' ? env.RECIPEAPI_API_KEY : env.SPOONACULAR_API_KEY;
  const plan = provider === 'recipeapi' ? env.RECIPEAPI_PLAN : env.SPOONACULAR_PLAN;
  if (plan !== 'free' || typeof value !== 'string') return null;
  return (provider === 'recipeapi'
    ? /^sk_live_[A-Za-z0-9_-]{16,128}$/
    : /^[A-Za-z0-9_-]{16,128}$/
  ).test(value)
    ? value
    : null;
}

export function recipeProviderStatuses(env: RecipeProviderEnv): RecipeProviderStatus[] {
  return RECIPE_PROVIDER_INFO.map((provider) => ({
    ...provider,
    configured: key(env, provider.id) !== null,
  }));
}

function reserve(state: ProviderCounter, input: RecipeProviderSearch, now: number): void {
  const month = new Date(now).toISOString().slice(0, 7);
  const day = Math.floor(now / 86_400_000);
  if (state.month !== month) {
    state.month = month;
    state.monthlyRequests = 0;
  }
  if (state.day !== day) {
    state.day = day;
    state.dailyPoints = 0;
  }
  if (now - state.minuteStart >= 60_000) {
    state.minuteStart = now;
    state.minuteRequests = 0;
  }
  if (now < state.pausedUntil)
    throw new RecipeProviderError(
      429,
      'provider_quota',
      'This recipe source is paused after reaching its free allowance. Your built-in library is still available.',
      Math.max(1, Math.ceil((state.pausedUntil - now) / 1000)),
    );
  if (state.inFlight)
    throw new RecipeProviderError(
      429,
      'provider_busy',
      'A recipe search is already running. Please wait.',
      2,
    );
  if (
    state.minuteRequests >= 6 ||
    (input.provider === 'spoonacular' && state.lastRequest !== 0 && now - state.lastRequest < 1000)
  )
    throw new RecipeProviderError(
      429,
      'provider_rate_limit',
      'Please wait a moment before searching this source again.',
      state.minuteRequests >= 6
        ? Math.max(1, Math.ceil((state.minuteStart + 60_000 - now) / 1000))
        : 1,
    );
  if (input.provider === 'recipeapi' && state.monthlyRequests >= 500)
    throw new RecipeProviderError(
      429,
      'provider_quota',
      'RecipeAPI.io has reached Mise’s 500-request monthly limit. Use the built-in library until next month.',
    );
  // Complex search with full ingredients and instructions costs 1 + 0.06 points/result.
  const points = 1 + 0.06 * (input.limit ?? 10);
  if (input.provider === 'spoonacular' && state.dailyPoints + points > 50)
    throw new RecipeProviderError(
      429,
      'provider_quota',
      'Spoonacular has reached Mise’s 50-point daily limit. Use the built-in library until tomorrow.',
    );
  state.monthlyRequests++;
  state.minuteRequests++;
  state.dailyPoints += points;
  state.lastRequest = now;
  state.inFlight = true;
}

async function boundedJson(response: Response): Promise<unknown> {
  const limit = 512 * 1024;
  const declared = response.headers.get('Content-Length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    await response.body?.cancel();
    throw new RecipeProviderError(
      502,
      'provider_response',
      'This recipe source returned too much data. Search for a more specific dish.',
    );
  }
  if (!response.body)
    throw new RecipeProviderError(
      502,
      'provider_response',
      'This recipe source returned an empty response.',
    );
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new RecipeProviderError(
          502,
          'provider_response',
          'This recipe source returned too much data. Search for a more specific dish.',
        );
      }
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new RecipeProviderError(
      502,
      'provider_response',
      'This recipe source returned an unreadable response. Try again later.',
    );
  }
}

export async function searchRecipeProvider(
  input: RecipeProviderSearch,
  env: RecipeProviderEnv,
  state: RecipeProviderState,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<RecipeProviderResults> {
  const credential = key(env, input.provider);
  if (!credential)
    throw new RecipeProviderError(
      503,
      'provider_configuration',
      'Enable this source with its free-plan API key in your Cloudflare Worker. Existing recipes and Gemini still work.',
    );
  const page = input.page ?? 1;
  const limit = input.limit ?? 10;
  const providerState = state[input.provider];
  reserve(providerState, input, now());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const endpoint = new URL(
      input.provider === 'recipeapi'
        ? 'https://recipeapi.io/api/v1/recipes'
        : 'https://api.spoonacular.com/recipes/complexSearch',
    );
    if (input.provider === 'recipeapi') {
      if (input.query) {
        endpoint.searchParams.set('search', input.query);
        endpoint.searchParams.set('search_in', 'both');
      }
      if (input.ingredients?.length)
        endpoint.searchParams.set('ingredients', input.ingredients.join(','));
      endpoint.searchParams.set('page', String(page));
      endpoint.searchParams.set('per_page', String(limit));
      // No paid localization, scaling, imperial conversion, or hidden detail fetches.
    } else {
      if (input.query) endpoint.searchParams.set('query', input.query);
      if (input.ingredients?.length) {
        endpoint.searchParams.set('includeIngredients', input.ingredients.join(','));
        endpoint.searchParams.set('sort', 'max-used-ingredients');
      }
      endpoint.searchParams.set('offset', String((page - 1) * limit));
      endpoint.searchParams.set('number', String(limit));
      endpoint.searchParams.set('instructionsRequired', 'true');
      endpoint.searchParams.set('addRecipeInformation', 'true');
      endpoint.searchParams.set('addRecipeInstructions', 'true');
    }
    const response = await fetcher(endpoint.href, {
      headers:
        input.provider === 'recipeapi'
          ? { Authorization: `Bearer ${credential}` }
          : { 'x-api-key': credential },
      redirect: 'error',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (input.provider === 'spoonacular') {
      const used = response.headers.get('X-API-Quota-Used');
      if (used !== null && Number.isFinite(Number(used)))
        providerState.dailyPoints = Math.max(providerState.dailyPoints, Number(used));
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403)
        throw new RecipeProviderError(
          503,
          'provider_configuration',
          'This recipe source rejected its API key. Check the free-plan key in Cloudflare settings.',
        );
      if (response.status === 402 || response.status === 429) {
        const requestedPause = Number(response.headers.get('Retry-After'));
        const seconds =
          response.status === 402 && input.provider === 'spoonacular'
            ? Math.max(
                1,
                Math.ceil(((Math.floor(now() / 86_400_000) + 1) * 86_400_000 - now()) / 1000),
              )
            : Number.isFinite(requestedPause) && requestedPause > 0
              ? Math.min(requestedPause, 86400)
              : 60;
        providerState.pausedUntil = now() + seconds * 1000;
        throw new RecipeProviderError(
          429,
          'provider_quota',
          'This recipe source has reached a free allowance or rate limit. Try later; Mise will not retry or switch to a paid service.',
          seconds,
        );
      }
      throw new RecipeProviderError(
        502,
        'provider_unavailable',
        'This recipe source is unavailable. Your saved and built-in recipes are still available.',
      );
    }
    const body = await boundedJson(response);
    const entries = isRecord(body)
      ? body[input.provider === 'recipeapi' ? 'data' : 'results']
      : undefined;
    if (!Array.isArray(entries) || entries.length > limit)
      throw new RecipeProviderError(
        502,
        'provider_response',
        'This recipe source returned a format Mise cannot safely read.',
      );
    const recipes = entries
      .map((entry) =>
        input.provider === 'recipeapi' ? recipeApiToRecipe(entry) : spoonacularToRecipe(entry),
      )
      .filter((recipe): recipe is Recipe => recipe !== null);
    const skipped = entries.length - recipes.length;
    const warnings = skipped
      ? [
          `${skipped} ${skipped === 1 ? 'recipe was' : 'recipes were'} omitted because complete ingredients or instructions could not be read safely.`,
        ]
      : [];
    if (input.provider === 'spoonacular')
      warnings.push(
        'Online discovery only. Open the original source to use this recipe; Spoonacular results are not saved or included in backups.',
      );
    const meta = isRecord(body) && isRecord(body.meta) ? body.meta : null;
    const total =
      isRecord(body) && typeof body.totalResults === 'number' && Number.isFinite(body.totalResults)
        ? body.totalResults
        : null;
    const hasMore =
      input.provider === 'recipeapi'
        ? meta && typeof meta.last_page === 'number'
          ? page < Math.min(meta.last_page, 5000)
          : entries.length === limit && page < 5000
        : page * limit <= 900 &&
          (total !== null ? (page - 1) * limit + entries.length < total : entries.length === limit);
    return {
      provider: input.provider,
      recipes,
      page,
      hasMore,
      warnings,
      storage: input.provider === 'recipeapi' ? 'personal' : 'session',
      ...(input.provider === 'spoonacular' ? { expiresAt: now() + 60 * 60 * 1000 } : {}),
    };
  } catch (error) {
    if (error instanceof RecipeProviderError) throw error;
    throw new RecipeProviderError(
      502,
      controller.signal.aborted ? 'provider_timeout' : 'provider_unavailable',
      controller.signal.aborted
        ? 'The recipe search took too long. Try a more specific dish.'
        : 'This recipe source could not be reached. Your existing recipes are still available.',
    );
  } finally {
    clearTimeout(timer);
    providerState.inFlight = false;
  }
}
