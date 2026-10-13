import { GeminiError, requestMiseWorker, type GeminiConnection } from '../ai/client';
import {
  copyFoodNutrition,
  isFoodNutrition,
  parseNutritionSearchResults,
  parseNutritionStatus,
  type FoodNutrition,
  type NutritionSearchResults,
  type NutritionStatus,
} from './types';

async function request(
  connection: GeminiConnection,
  path: string,
  input?: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  try {
    return await requestMiseWorker(connection, path, input, signal);
  } catch (error) {
    if (error instanceof GeminiError && error.code === 'not_found')
      throw new GeminiError(
        'worker_update',
        'Nutrition lookup needs the latest Worker. Download it from Mise settings and replace your Worker code.',
      );
    throw error;
  }
}

export async function nutritionStatus(
  connection: GeminiConnection,
  signal?: AbortSignal,
): Promise<NutritionStatus> {
  const result = parseNutritionStatus(
    await request(connection, '/nutrition/status', undefined, signal),
  );
  if (!result)
    throw new GeminiError(
      'nutrition_response',
      'The Worker returned unsupported nutrition settings. Update the Worker from Mise settings.',
    );
  return result;
}

export async function searchNutritionFoods(
  connection: GeminiConnection,
  query: string,
  signal?: AbortSignal,
): Promise<NutritionSearchResults> {
  const normalized = query.trim();
  if (normalized.length < 2 || normalized.length > 120)
    throw new GeminiError('invalid_request', 'Enter a food name between 2 and 120 characters.');
  const result = parseNutritionSearchResults(
    await request(connection, '/nutrition/search', { query: normalized }, signal),
  );
  if (!result || result.query !== normalized)
    throw new GeminiError(
      'nutrition_response',
      'USDA returned food records Mise cannot safely display.',
    );
  return result;
}

export async function getNutritionFood(
  connection: GeminiConnection,
  fdcId: number,
  signal?: AbortSignal,
): Promise<FoodNutrition> {
  if (!Number.isSafeInteger(fdcId) || fdcId <= 0)
    throw new GeminiError('invalid_request', 'Choose a valid USDA food record.');
  const result = await request(connection, '/nutrition/food', { fdcId }, signal);
  const food =
    typeof result === 'object' && result !== null && 'food' in result ? result.food : null;
  if (!isFoodNutrition(food) || food.fdcId !== fdcId)
    throw new GeminiError(
      'nutrition_response',
      'USDA returned food data Mise cannot safely display.',
    );
  return copyFoodNutrition(food);
}
