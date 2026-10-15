import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveGeminiConnection } from '../ai/client';
import { getNutritionFood, searchNutritionFoods } from '../nutrition/client';
import { recipeNutritionKey } from '../nutrition/estimate';
import type { FoodNutrition } from '../nutrition/types';
import type { Recipe } from '../recipes/types';
import { RecipeNutrition } from './RecipeNutrition';

vi.mock('../nutrition/client', () => ({
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
  it('shows declared publisher nutrition immediately without requiring USDA work or guessing a serving basis', () => {
    render(
      <RecipeNutrition
        recipe={{
          ...recipe,
          publisherNutrition: { calories: '400 kcal', protein: '25 g', carbohydrates: '45 g' },
        }}
        onSave={vi.fn()}
        onConfigure={vi.fn()}
      />,
    );
    const published = screen.getByLabelText('Publisher nutrition');
    expect(within(published).getByText('400 kcal')).toBeVisible();
    expect(within(published).getByText('25 g')).toBeVisible();
    expect(within(published).getByText(/Serving basis not recorded/)).toBeVisible();
    expect(within(published).getByText('Not recorded')).toBeVisible();
    expect(screen.queryByLabelText('Nutrition amounts')).not.toBeInTheDocument();
    expect(searchNutritionFoods).not.toHaveBeenCalled();
  });
  it('opens ingredient review without a diagnostic test or spending a search', async () => {
    render(<RecipeNutrition recipe={recipe} onSave={vi.fn()} onConfigure={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Estimate with USDA' }));
    expect(screen.getByRole('button', { name: 'Match food' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Test USDA lookup' })).not.toBeInTheDocument();
    expect(searchNutritionFoods).not.toHaveBeenCalled();
  });

  it('shows whole recipe nutrition even when the source has no serving yield', async () => {
    const unknownYield = { ...recipe, servings: null };
    render(
      <RecipeNutrition
        recipe={unknownYield}
        mapping={{
          recipeKey: recipeNutritionKey(unknownYield),
          ingredients: [{ ingredientIndex: 0, food, grams: 180, confirmed: true }],
        }}
        onSave={vi.fn()}
        onConfigure={vi.fn()}
      />,
    );
    expect(screen.getByText('72 kcal')).toBeInTheDocument();
    expect(screen.getByText('1.8 g')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Per serving' })).toBeDisabled();
    expect(screen.getByText(/Whole-recipe amounts are shown/)).toBeInTheDocument();
    expect(screen.getByText(/All nutrients available/)).toBeInTheDocument();
  });

  it('switches from per-serving values to whole recipe totals', async () => {
    render(
      <RecipeNutrition
        recipe={recipe}
        mapping={{
          recipeKey: recipeNutritionKey(recipe),
          ingredients: [{ ingredientIndex: 0, food, grams: 180, confirmed: true }],
        }}
        onSave={vi.fn()}
        onConfigure={vi.fn()}
      />,
    );
    expect(screen.getByText('36 kcal')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Whole recipe' }));
    expect(screen.getByText('72 kcal')).toBeInTheDocument();
  });

  it('labels known subtotals as partial when another ingredient is unreviewed', () => {
    const incomplete = {
      ...recipe,
      ingredients: [...recipe.ingredients, { name: 'Oil', quantity: 1, unit: 'tbsp' }],
    };
    render(
      <RecipeNutrition
        recipe={incomplete}
        mapping={{
          recipeKey: recipeNutritionKey(incomplete),
          ingredients: [{ ingredientIndex: 0, food, grams: 180, confirmed: true }],
        }}
        onSave={vi.fn()}
        onConfigure={vi.fn()}
      />,
    );
    expect(screen.getByText('36 kcal')).toBeInTheDocument();
    expect(screen.getAllByText('Partial estimate')).toHaveLength(4);
    expect(screen.getByText(/Partial values cover reviewed ingredients only/)).toBeInTheDocument();
    expect(screen.queryByText(/All nutrients available/)).not.toBeInTheDocument();
  });

  it('explains missing nutrient fields instead of filling them with zero', () => {
    render(
      <RecipeNutrition
        recipe={recipe}
        mapping={{
          recipeKey: recipeNutritionKey(recipe),
          ingredients: [
            {
              ingredientIndex: 0,
              food: { ...food, per100g: { ...food.per100g, caloriesKcal: null } },
              grams: 180,
              confirmed: true,
            },
          ],
        }}
        onSave={vi.fn()}
        onConfigure={vi.fn()}
      />,
    );
    expect(screen.getByText(/Some selected foods don’t report every nutrient/)).toBeInTheDocument();
    expect(screen.getByText('Not recorded')).toBeInTheDocument();
    expect(screen.queryByText('0 kcal')).not.toBeInTheDocument();
  });

  it('shows an actionable failure in the real ingredient lookup and preserves saved data', async () => {
    vi.mocked(searchNutritionFoods).mockRejectedValueOnce(
      new Error('USDA rejected this API key. Check the Worker secret.'),
    );
    const onSave = vi.fn();
    render(<RecipeNutrition recipe={recipe} onSave={onSave} onConfigure={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Estimate with USDA' }));
    await user.click(screen.getByRole('button', { name: 'Match food' }));
    await user.click(screen.getByRole('button', { name: 'Search USDA' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('USDA rejected this API key');
    expect(onSave).not.toHaveBeenCalled();
  });

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
