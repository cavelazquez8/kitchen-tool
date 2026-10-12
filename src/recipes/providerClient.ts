import { GeminiError, requestMiseWorker, type GeminiConnection } from '../ai/client';
import {
  parseRecipeProviderResults,
  parseRecipeProviderSearch,
  parseRecipeProviderStatuses,
  type RecipeProviderResults,
  type RecipeProviderSearch,
  type RecipeProviderStatus,
} from './providers';

export async function queryRecipeProviders(
  connection: GeminiConnection,
  signal?: AbortSignal,
): Promise<RecipeProviderStatus[]> {
  try {
    const result = parseRecipeProviderStatuses(
      await requestMiseWorker(connection, '/recipe-providers', undefined, signal),
    );
    if (!result)
      throw new GeminiError(
        'provider_response',
        'This Worker did not return supported recipe sources. Update the Worker from Mise settings.',
      );
    return result;
  } catch (error) {
    if (error instanceof GeminiError && error.code === 'not_found')
      throw new GeminiError(
        'worker_update',
        'Additional recipe sources need the latest Worker. Download the updated Worker from settings; your current Gemini connection still works.',
      );
    throw error;
  }
}

export async function searchRecipeProviders(
  connection: GeminiConnection,
  input: RecipeProviderSearch,
  signal?: AbortSignal,
): Promise<RecipeProviderResults> {
  const validated = parseRecipeProviderSearch(input);
  if (!validated)
    throw new GeminiError(
      'invalid_request',
      'Enter a dish or ingredient and choose a supported recipe source.',
    );
  try {
    const result = parseRecipeProviderResults(
      await requestMiseWorker(connection, '/recipes/search', validated, signal),
      validated.provider,
    );
    if (!result)
      throw new GeminiError(
        'provider_response',
        'This recipe source returned data Mise cannot safely display. Your recipes have not changed.',
      );
    return result;
  } catch (error) {
    if (error instanceof GeminiError && error.code === 'not_found')
      throw new GeminiError(
        'worker_update',
        'Download the updated Worker from settings to enable additional recipe sources.',
      );
    throw error;
  }
}
