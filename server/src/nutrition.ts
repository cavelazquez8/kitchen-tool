import { isRecord } from '../../src/ai/protocol';
import {
  isFoodNutrition,
  USDA_DATA_TYPES,
  type FoodNutrition,
  type NutritionSearchResults,
  type NutritionStatus,
  type NutritionValues,
  type UsdaDataType,
} from '../../src/nutrition/types';
import { workerOutboundOptions } from './outbound';

export interface NutritionEnv {
  USDA_API_KEY?: string;
}

export class NutritionError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'NutritionError';
  }
}

export interface NutritionState {
  minuteStart: number;
  minuteRequests: number;
  hourStart: number;
  hourRequests: number;
  inFlight: boolean;
  pausedUntil: number;
}

export function createNutritionState(): NutritionState {
  return {
    minuteStart: 0,
    minuteRequests: 0,
    hourStart: 0,
    hourRequests: 0,
    inFlight: false,
    pausedUntil: 0,
  };
}

const fallbackState = createNutritionState();

function credential(env: NutritionEnv): string | null {
  return typeof env.USDA_API_KEY === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(env.USDA_API_KEY)
    ? env.USDA_API_KEY
    : null;
}

export function nutritionProviderStatus(env: NutritionEnv): NutritionStatus {
  return { provider: 'usda', configured: credential(env) !== null };
}

function reserve(state: NutritionState, now: number): void {
  if (now < state.pausedUntil)
    throw new NutritionError(
      429,
      'nutrition_quota',
      'USDA nutrition lookup is paused after reaching its allowance. Your saved estimates still work.',
      Math.max(1, Math.ceil((state.pausedUntil - now) / 1000)),
    );
  if (state.inFlight)
    throw new NutritionError(
      429,
      'nutrition_busy',
      'A nutrition lookup is already running. Please wait.',
      2,
    );
  if (now - state.minuteStart >= 60_000) {
    state.minuteStart = now;
    state.minuteRequests = 0;
  }
  if (now - state.hourStart >= 3_600_000) {
    state.hourStart = now;
    state.hourRequests = 0;
  }
  if (state.minuteRequests >= 20 || state.hourRequests >= 900)
    throw new NutritionError(
      429,
      'nutrition_rate_limit',
      'Please wait before looking up more nutrition data.',
      Math.max(
        1,
        Math.ceil(
          ((state.minuteRequests >= 20 ? state.minuteStart + 60_000 : state.hourStart + 3_600_000) -
            now) /
            1000,
        ),
      ),
    );
  state.minuteRequests++;
  state.hourRequests++;
  state.inFlight = true;
}

async function boundedJson(
  response: Pick<Response, 'headers' | 'body'>,
  maxBytes: number,
  upstream: boolean,
): Promise<unknown> {
  const error = () =>
    new NutritionError(
      upstream ? 502 : 400,
      upstream ? 'nutrition_response' : 'invalid_request',
      upstream
        ? 'USDA returned data Mise cannot safely read. Try a more specific food.'
        : 'Enter a food name or a valid USDA food ID.',
    );
  const length = response.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    await response.body?.cancel();
    throw error();
  }
  if (!response.body) throw error();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw error();
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
    throw error();
  }
}

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100_000;
}

/** Handles both full food details and the search endpoint's flattened nutrient fields. */
function nutrients(value: unknown): NutritionValues {
  const entries = Array.isArray(value) ? value : [];
  const find = (id: number, number: string | null, unit: string): number | null => {
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const nutrient = isRecord(entry.nutrient) ? entry.nutrient : entry;
      const nutrientId = isRecord(entry.nutrient) ? nutrient.id : entry.nutrientId;
      const nutrientNumber = nutrient.number ?? nutrient.nutrientNumber;
      const nutrientUnit = nutrient.unitName ?? nutrient.unit;
      const amount = isRecord(entry.nutrient) ? entry.amount : (entry.value ?? entry.amount);
      if (
        (nutrientId === id || (number !== null && String(nutrientNumber) === number)) &&
        typeof nutrientUnit === 'string' &&
        nutrientUnit.toLowerCase() === unit &&
        nonnegative(amount)
      )
        return amount;
    }
    return null;
  };
  return {
    // USDA Foundation foods use Atwater specific/general energy, not just legacy1008.
    caloriesKcal: find(2048, null, 'kcal') ?? find(2047, null, 'kcal') ?? find(1008, '208', 'kcal'),
    proteinGrams: find(1003, '203', 'g'),
    carbsGrams: find(1005, '205', 'g'),
    fatGrams: find(1004, '204', 'g'),
  };
}

function cleanText(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
    ? value.trim()
    : null;
}

export function parseUsdaFood(value: unknown): FoodNutrition | null {
  if (!isRecord(value) || !Number.isSafeInteger(value.fdcId) || (value.fdcId as number) <= 0)
    return null;
  const description = cleanText(value.description, 600);
  if (!description || !USDA_DATA_TYPES.includes(value.dataType as UsdaDataType)) return null;
  const portions: FoodNutrition['portions'] = [];
  if (Array.isArray(value.foodPortions)) {
    for (const portion of value.foodPortions.slice(0, 30)) {
      if (!isRecord(portion) || !nonnegative(portion.gramWeight) || portion.gramWeight <= 0)
        continue;
      const measure = isRecord(portion.measureUnit)
        ? cleanText(portion.measureUnit.name, 100)
        : null;
      const parts = [
        typeof portion.amount === 'number' && Number.isFinite(portion.amount) && portion.amount > 0
          ? String(portion.amount)
          : '',
        measure && !['undetermined', 'unknown'].includes(measure.toLowerCase()) ? measure : '',
        cleanText(portion.modifier, 150) ?? '',
      ].filter(Boolean);
      const label =
        cleanText(portion.portionDescription, 300) ??
        (parts.length ? parts.join(' ') : 'Recorded portion');
      portions.push({ label, gramWeight: portion.gramWeight });
    }
  }
  // Brand labelNutrients are per serving and must not be mistaken for foodNutrients per100g.
  if (
    portions.length < 30 &&
    value.dataType === 'Branded' &&
    typeof value.servingSizeUnit === 'string' &&
    ['g', 'gram', 'grams'].includes(value.servingSizeUnit.toLowerCase()) &&
    nonnegative(value.servingSize) &&
    value.servingSize > 0
  )
    portions.push({
      label:
        cleanText(value.householdServingFullText, 300) ?? `${value.servingSize} g (label serving)`,
      gramWeight: value.servingSize,
    });
  const brand = cleanText(value.brandOwner, 300);
  const food: FoodNutrition = {
    fdcId: value.fdcId as number,
    description,
    dataType: value.dataType as UsdaDataType,
    sourceUrl: `https://fdc.nal.usda.gov/food-details/${value.fdcId}/nutrients`,
    ...(brand ? { brand } : {}),
    per100g: nutrients(value.foodNutrients),
    portions,
  };
  return isFoodNutrition(food) ? food : null;
}

async function usdaRequest(
  path: string,
  input: unknown | undefined,
  key: string,
  fetcher: typeof fetch,
  state: NutritionState,
  now: () => number,
): Promise<unknown> {
  reserve(state, now());
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const endpoint = new URL(`https://api.nal.usda.gov/fdc/v1${path}`);
    endpoint.searchParams.set('api_key', key);
    const response = await fetcher(endpoint.href, {
      ...workerOutboundOptions(
        {
          Accept: 'application/json',
          ...(input === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        controller.signal,
      ),
      method: input === undefined ? 'GET' : 'POST',
      redirect: 'manual',
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status >= 300 && response.status < 400)
        throw new NutritionError(
          502,
          'nutrition_redirect',
          'USDA redirected the request. Mise did not forward your API key.',
        );
      if (response.status === 401 || response.status === 403)
        throw new NutritionError(
          503,
          'nutrition_configuration',
          'Check USDA_API_KEY in your Cloudflare Worker.',
        );
      if (response.status === 429) {
        state.pausedUntil = now() + 3_600_000;
        throw new NutritionError(
          429,
          'nutrition_quota',
          'USDA has reached its current allowance. Try again in an hour; saved estimates still work.',
          3600,
        );
      }
      if (response.status === 404)
        throw new NutritionError(
          404,
          'nutrition_food_not_found',
          'This USDA food record was not found. Search for the food again.',
        );
      throw new NutritionError(
        502,
        'nutrition_unavailable',
        'USDA nutrition data could not be reached. Try again later.',
      );
    }
    return await boundedJson(response, 768 * 1024, true);
  } catch (error) {
    if (error instanceof NutritionError) throw error;
    throw new NutritionError(
      502,
      'nutrition_unavailable',
      'USDA nutrition data could not be reached. Try again later.',
    );
  } finally {
    clearTimeout(timeout);
    state.inFlight = false;
  }
}

/** The caller authenticates the request and attaches its normal CORS/error headers. */
export async function handleNutritionRequest(
  request: Request,
  env: NutritionEnv,
  fetcher: typeof fetch = fetch,
  state: NutritionState = fallbackState,
  now: () => number = Date.now,
): Promise<{
  status: number;
  body: NutritionStatus | NutritionSearchResults | { food: FoodNutrition };
}> {
  const path = new URL(request.url).pathname;
  if (path === '/nutrition/status') {
    if (request.method !== 'GET')
      throw new NutritionError(405, 'method', 'Use GET to check nutrition setup.');
    return { status: 200, body: nutritionProviderStatus(env) };
  }
  if (!['/nutrition/search', '/nutrition/food'].includes(path))
    throw new NutritionError(404, 'not_found', 'This endpoint does not exist.');
  if (request.method !== 'POST')
    throw new NutritionError(405, 'method', 'Use POST for nutrition lookup.');
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))
    throw new NutritionError(400, 'invalid_request', 'Send nutrition lookup as JSON.');
  const input = await boundedJson(request, 4096, false);
  const key = credential(env);
  if (!key)
    throw new NutritionError(
      503,
      'nutrition_configuration',
      'Add a free USDA FoodData Central key as USDA_API_KEY in your Cloudflare Worker.',
    );
  if (path === '/nutrition/search') {
    const query =
      isRecord(input) && Object.keys(input).every((name) => name === 'query')
        ? cleanText(input.query, 120)
        : null;
    if (!query || query.length < 2)
      throw new NutritionError(
        400,
        'invalid_request',
        'Enter at least two characters of a food name.',
      );
    const result = await usdaRequest(
      '/foods/search',
      { query, pageSize: 10, dataType: [...USDA_DATA_TYPES] },
      key,
      fetcher,
      state,
      now,
    );
    if (!isRecord(result) || !Array.isArray(result.foods) || result.foods.length > 10)
      throw new NutritionError(
        502,
        'nutrition_response',
        'USDA returned data Mise cannot safely read.',
      );
    const foods = result.foods
      .map(parseUsdaFood)
      .filter((food): food is FoodNutrition => food !== null);
    if (result.foods.length > 0 && foods.length === 0)
      throw new NutritionError(
        502,
        'nutrition_response',
        'USDA returned food records Mise cannot safely read. Try a different food name.',
      );
    return {
      status: 200,
      body: { query, foods, rejectedCount: result.foods.length - foods.length },
    };
  }
  if (
    !isRecord(input) ||
    Object.keys(input).some((name) => name !== 'fdcId') ||
    !Number.isSafeInteger(input.fdcId) ||
    (input.fdcId as number) <= 0
  )
    throw new NutritionError(400, 'invalid_request', 'Choose a valid USDA food record.');
  const food = parseUsdaFood(
    await usdaRequest(`/food/${input.fdcId}`, undefined, key, fetcher, state, now),
  );
  if (!food || food.fdcId !== input.fdcId)
    throw new NutritionError(
      502,
      'nutrition_response',
      'USDA returned food data Mise cannot safely read.',
    );
  return { status: 200, body: { food } };
}
