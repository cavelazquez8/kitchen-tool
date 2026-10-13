import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveGeminiConnection } from '../ai/client';
import { getNutritionFood, nutritionStatus, searchNutritionFoods } from '../nutrition/client';
import { recipeNutritionKey } from '../nutrition/estimate';
import type { FoodNutrition } from '../nutrition/types';
import type { Recipe } from '../recipes/types';
import { RecipeNutrition } from './RecipeNutrition';

vi.mock('../nutrition/client', () => ({
  nutritionStatus: vi.fn(),
  searchNutritionFoods: vi.fn(),
  getNutritionFood: vi.fn(),
}));
const food: FoodNutrition = {
  fdcId: 123,
  description: 'Synthetic fixture carrots, raw',
  dataType: 'Foundation',
  sourceUrl: 'https://fdc.nal.usda.gov/food-details/123/nutrients',
  per100g: { caloriesKcal: 40, proteinGrams: 1, carbsGrams: 9, fatGrams: 0 },
  portions: [{ label: '1 recorded fixture piece', gramWeight: 90 }],
};
const recipe: Recipe = {
  id: 'nutrition-component-fixture',
  title: 'Synthetic fixture recipe',
  servings: 2,
  ingredients: [{ name: 'Carrots', quantity: 2, unit: 'each' }],
  steps: ['Synthetic fixture only.'],
  source: { type: 'manual' },
};
beforeEach(() => {
  localStorage.clear();
  saveGeminiConnection({
    url: 'https://mise.example.workers.dev',
    token: 'test_only_' + 'a'.repeat(40),
  });
  vi.mocked(nutritionStatus).mockResolvedValue({ provider: 'usda', configured: true });
  vi.mocked(searchNutritionFoods).mockResolvedValue({
    query: 'Carrots',
    foods: [food],
    rejectedCount: 0,
  });
  vi.mocked(getNutritionFood).mockResolvedValue(food);
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

describe('recipe food and weight review', () => {
  it('distinguishes a configured key from verified live USDA access without spending a food search', async () => {
    render(<RecipeNutrition recipe={recipe} onSave={vi.fn()} onConfigure={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Estimate with USDA' }));
    expect(
      await screen.findByText('USDA key configured. Live access has not been verified.'),
    ).toBeInTheDocument();
    expect(nutritionStatus).toHaveBeenCalledTimes(1);
    expect(searchNutritionFoods).not.toHaveBeenCalled();
  });

  it('verifies live access with one explicit test search without choosing or saving a food', async () => {
    const onSave = vi.fn();
    render(<RecipeNutrition recipe={recipe} onSave={onSave} onConfigure={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Estimate with USDA' }));
    await user.click(screen.getByRole('button', { name: 'Test USDA lookup' }));
    expect(
      await screen.findByText('USDA lookup verified: 1 food returned for “Carrots”.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Live USDA access verified.')).toBeInTheDocument();
    expect(searchNutritionFoods).toHaveBeenCalledTimes(1);
    expect(searchNutritionFoods).toHaveBeenCalledWith(
      expect.any(Object),
      'Carrots',
      expect.any(AbortSignal),
    );
    expect(getNutritionFood).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Match food' })).toBeInTheDocument();
  });

  it('recognizes a valid empty response as live access while reporting no matches', async () => {
    vi.mocked(searchNutritionFoods).mockResolvedValueOnce({
      query: 'Carrots',
      foods: [],
      rejectedCount: 0,
    });
    render(<RecipeNutrition recipe={recipe} onSave={vi.fn()} onConfigure={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Estimate with USDA' }));
    await user.click(screen.getByRole('button', { name: 'Test USDA lookup' }));
    expect(
      await screen.findByText(
        'USDA lookup verified: USDA responded, but no foods matched “Carrots”.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Live USDA access verified.')).toBeInTheDocument();
  });

  it('refreshes setup before a test and avoids searching when the USDA key is missing', async () => {
    vi.mocked(nutritionStatus).mockResolvedValue({ provider: 'usda', configured: false });
    render(<RecipeNutrition recipe={recipe} onSave={vi.fn()} onConfigure={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Estimate with USDA' }));
    await user.click(screen.getByRole('button', { name: 'Test USDA lookup' }));
    expect(screen.getByText(/Add the free USDA key as/)).toBeInTheDocument();
    expect(nutritionStatus).toHaveBeenCalledTimes(2);
    expect(searchNutritionFoods).not.toHaveBeenCalled();
    expect(screen.queryByText('Live USDA access verified.')).not.toBeInTheDocument();
  });

  it('reports a failed live test instead of treating key presence as a successful connection', async () => {
    vi.mocked(searchNutritionFoods).mockRejectedValueOnce(
      new Error('USDA rejected this API key. Check the Worker secret.'),
    );
    render(<RecipeNutrition recipe={recipe} onSave={vi.fn()} onConfigure={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Estimate with USDA' }));
    await user.click(screen.getByRole('button', { name: 'Test USDA lookup' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'USDA rejected this API key. Check the Worker secret.',
    );
    expect(
      screen.getByText('USDA key configured. The last live lookup failed.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test USDA lookup' })).toBeEnabled();
    expect(screen.queryByText('Live USDA access verified.')).not.toBeInTheDocument();
  });

  it('requires a chosen food and confirmed grams, without assuming weight for a count', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<RecipeNutrition recipe={recipe} onSave={onSave} onConfigure={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Estimate with USDA' }));
    await user.click(screen.getByRole('button', { name: 'Match food' }));
    await user.click(screen.getByRole('button', { name: 'Search USDA' }));
    expect(await screen.findByText('Live USDA access verified.')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /Synthetic fixture carrots, raw/ }));
    const grams = await screen.findByRole('spinbutton', { name: 'Grams of Carrots' });
    expect(grams).toHaveValue(null);
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Confirm food and amount' })).toBeDisabled();
    await user.type(grams, '180');
    expect(onSave).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Confirm food and amount' }));
    expect(onSave).toHaveBeenCalledWith({
      recipeKey: recipeNutritionKey(recipe),
      ingredients: [{ ingredientIndex: 0, food, grams: 180, confirmed: true }],
    });
    expect(await screen.findByText('36 kcal')).toBeInTheDocument();
  });

  it('prefills a recorded mass but still waits for explicit confirmation', async () => {
    const massRecipe = { ...recipe, ingredients: [{ name: 'Carrots', quantity: 250, unit: 'g' }] };
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<RecipeNutrition recipe={massRecipe} onSave={onSave} onConfigure={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Estimate with USDA' }));
    await user.click(screen.getByRole('button', { name: 'Match food' }));
    await user.click(screen.getByRole('button', { name: 'Search USDA' }));
    await user.click(await screen.findByRole('button', { name: /Synthetic fixture carrots, raw/ }));
    expect(await screen.findByRole('spinbutton', { name: 'Grams of Carrots' })).toHaveValue(250);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('keeps stale saved matches out of estimates and requests review again', async () => {
    const stale = {
      recipeKey: recipeNutritionKey(recipe),
      ingredients: [{ ingredientIndex: 0, food, grams: 180, confirmed: true as const }],
    };
    const changed = { ...recipe, servings: 4 };
    render(
      <RecipeNutrition recipe={changed} mapping={stale} onSave={vi.fn()} onConfigure={vi.fn()} />,
    );
    const panel = screen.getByRole('region', { name: 'Recipe nutrition' });
    expect(
      within(panel).getByText('This recipe changed. Review the food matches again.'),
    ).toBeInTheDocument();
    expect(within(panel).queryByText('36 kcal')).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Estimate with USDA' }));
    expect(screen.getByRole('button', { name: 'Match food' })).toBeInTheDocument();
  });
});
