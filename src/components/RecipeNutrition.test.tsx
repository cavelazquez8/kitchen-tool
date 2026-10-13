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
  it('requires a chosen food and confirmed grams, without assuming weight for a count', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<RecipeNutrition recipe={recipe} onSave={onSave} onConfigure={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Estimate with USDA' }));
    await user.click(screen.getByRole('button', { name: 'Match food' }));
    await user.click(screen.getByRole('button', { name: 'Search USDA' }));
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
