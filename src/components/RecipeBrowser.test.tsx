import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveGeminiConnection } from '../ai/client';
import type { InventoryState } from '../domain/types';
import { searchRecipeProviders } from '../recipes/providerClient';
import type { Recipe } from '../recipes/types';
import { RecipeBrowser } from './RecipeBrowser';

vi.mock('../recipes/localLibrary', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../recipes/localLibrary')>()),
  loadLocalRecipes: vi.fn().mockResolvedValue([]),
}));
vi.mock('../recipes/providerClient', () => ({ searchRecipeProviders: vi.fn() }));

function recipe(id: string, title: string, ingredients: Recipe['ingredients']): Recipe {
  return {
    id,
    title,
    servings: 2,
    ingredients,
    steps: ['Follow the recorded recipe.'],
    source: { type: 'manual' },
  };
}

const recipes = [
  recipe('two-short', 'Alpha dinner', [
    { name: 'Chicken breast', quantity: 600, unit: 'g' },
    { name: 'Rice', quantity: 100, unit: 'g' },
  ]),
  recipe('one-short', 'Bravo dinner', [{ name: 'Chicken breast', quantity: 600, unit: 'g' }]),
  recipe('unknown', 'Yankee dinner', [{ name: 'Carrots', quantity: 100, unit: 'g' }]),
  recipe('ready', 'Zulu dinner', [{ name: 'Chicken breast', quantity: 400, unit: 'g' }]),
];

function inventory(): InventoryState {
  return {
    products: [
      { id: 'chicken', name: 'Chicken breast', isStaple: false },
      { id: 'carrots', name: 'Carrots', isStaple: false },
    ],
    batches: [
      {
        id: 'chicken:1',
        productId: 'chicken',
        quantity: 500,
        unit: 'g',
        location: 'fridge',
        purchasedOn: '2026-10-01',
        expiresOn: null,
      },
      {
        id: 'carrots:1',
        productId: 'carrots',
        quantity: null,
        unit: 'g',
        location: 'fridge',
        purchasedOn: '2026-10-01',
        expiresOn: null,
      },
    ],
    tools: [],
    recipes,
  };
}

function props(kitchen = inventory()) {
  return {
    inventory: kitchen,
    relevant: kitchen,
    selectedBatchIds: [],
    useSelection: false,
    onUseSelectionChange: vi.fn(),
    onOpen: vi.fn(),
    onSave: vi.fn(),
    onRemoveSaved: vi.fn(),
    onAddToGemini: vi.fn(),
    geminiRecipeIds: [],
    onImport: vi.fn(),
    onNew: vi.fn(),
    onConfigure: vi.fn(),
    savedReveal: null,
    onSavedRevealHandled: vi.fn(),
  };
}

function cardTitles(container: HTMLElement): (string | null)[] {
  return [...container.querySelectorAll('.recipe-grid h3')].map((heading) => heading.textContent);
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(searchRecipeProviders).mockReset();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('recipe shortage sorting', () => {
  it('sorts the current collection immediately, labels unknown amounts separately, and follows inventory edits', async () => {
    const kitchen = inventory();
    const initial = props(kitchen);
    const user = userEvent.setup();
    const { container, rerender } = render(<RecipeBrowser {...initial} />);
    await screen.findByText(/Showing 4 of 4 recipes/);
    expect(cardTitles(container)).toEqual([
      'Alpha dinner',
      'Bravo dinner',
      'Yankee dinner',
      'Zulu dinner',
    ]);
    await user.click(screen.getByRole('button', { name: 'Fewest ingredients short' }));
    expect(cardTitles(container)).toEqual([
      'Zulu dinner',
      'Yankee dinner',
      'Bravo dinner',
      'Alpha dinner',
    ]);
    const unknown = screen.getByRole('heading', { name: 'Yankee dinner' }).closest('article')!;
    expect(within(unknown).getByText('0 ingredients short · 1 amount to check')).toBeVisible();
    expect(within(unknown).getByText('Check quantities')).toBeVisible();
    expect(
      screen.getByText(/Missing ingredients and insufficient amounts count as short/),
    ).toBeVisible();

    const updated = {
      ...kitchen,
      batches: kitchen.batches.map((batch) =>
        batch.productId === 'chicken' ? { ...batch, quantity: 700 } : batch,
      ),
    };
    rerender(<RecipeBrowser {...initial} inventory={updated} relevant={updated} />);
    expect(cardTitles(container)).toEqual([
      'Bravo dinner',
      'Zulu dinner',
      'Yankee dinner',
      'Alpha dinner',
    ]);
    expect(screen.getByRole('button', { name: 'Fewest ingredients short' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(screen.getByRole('button', { name: 'Browse all' }));
    expect(cardTitles(container)).toEqual([
      'Alpha dinner',
      'Bravo dinner',
      'Yankee dinner',
      'Zulu dinner',
    ]);
    expect(searchRecipeProviders).not.toHaveBeenCalled();
  });

  it('reorders loaded online recipes without a second search or changing the results count', async () => {
    const online = recipes.map((item) => ({
      ...item,
      id: `recipeapi:${item.id}`,
      source: { type: 'imported' as const, name: 'RecipeAPI.io' },
    }));
    vi.mocked(searchRecipeProviders).mockResolvedValue({
      provider: 'recipeapi',
      storage: 'personal',
      recipes: online,
      page: 1,
      hasMore: false,
      warnings: [],
    });
    saveGeminiConnection({ url: 'https://mise.example.workers.dev', token: 'a'.repeat(43) });
    const user = userEvent.setup();
    const { container } = render(<RecipeBrowser {...props()} />);
    await screen.findByText(/Showing 4 of 4 recipes/);
    await user.click(screen.getByText('Other recipe sources'));
    await user.click(screen.getByRole('combobox', { name: 'Recipe source' }));
    await user.click(screen.getByRole('option', { name: 'RecipeAPI.io' }));
    await user.type(screen.getByRole('textbox', { name: 'Find recipes' }), 'dinner');
    await user.click(screen.getByRole('button', { name: 'Search RecipeAPI.io' }));
    await screen.findByText('4 recipes loaded · 4 match your filters.');
    expect(searchRecipeProviders).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Fewest ingredients short' }));
    expect(cardTitles(container)).toEqual([
      'Zulu dinner',
      'Yankee dinner',
      'Bravo dinner',
      'Alpha dinner',
    ]);
    expect(screen.getByText(/Showing 4 of 4 recipes · RecipeAPI.io/)).toBeVisible();
    expect(searchRecipeProviders).toHaveBeenCalledOnce();
  });
});
