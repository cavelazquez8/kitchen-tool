import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveGeminiConnection } from '../ai/client';
import type { InventoryState } from '../domain/types';
import { loadLocalRecipes } from '../recipes/localLibrary';
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
    category: id === 'ready' ? 'Soup' : 'Dinner',
    cuisine: id === 'unknown' ? 'French' : 'American',
    source: { type: 'manual' },
  };
}

const recipes = [
  recipe('two-short', 'Alpha dinner', [
    { name: 'Chicken breast', quantity: 600, unit: 'g' },
    { name: 'Rice', quantity: 100, unit: 'g' },
    { name: 'Carrots', quantity: 100, unit: 'g' },
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

async function choose(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  await user.click(screen.getByRole('combobox', { name: label }));
  await user.click(screen.getByRole('option', { name: option }));
}

async function chooseFilter(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  option: string,
) {
  await user.click(screen.getByRole('button', { name: /^Filters/ }));
  await choose(user, label, option);
  await user.click(screen.getByRole('button', { name: 'Show recipes' }));
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(searchRecipeProviders).mockReset();
  vi.mocked(loadLocalRecipes).mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('recipe matching sorting', () => {
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
    await user.click(screen.getByRole('combobox', { name: 'Sort by' }));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Name',
      'Most matches',
    ]);
    await user.click(screen.getByRole('option', { name: 'Most matches' }));
    expect(cardTitles(container)).toEqual([
      'Alpha dinner',
      'Zulu dinner',
      'Yankee dinner',
      'Bravo dinner',
    ]);
    const unknown = screen.getByRole('heading', { name: 'Yankee dinner' }).closest('article')!;
    expect(
      within(unknown).getByText('1 matching ingredient · 0 short · 1 amount to check'),
    ).toBeVisible();
    expect(within(unknown).getByText('Check quantities')).toBeVisible();
    expect(
      screen.getByText(/Matches count ingredients you have, even if you need more/),
    ).toBeVisible();

    const updated = {
      ...kitchen,
      batches: kitchen.batches.map((batch) =>
        batch.productId === 'chicken' ? { ...batch, quantity: 700 } : batch,
      ),
    };
    rerender(<RecipeBrowser {...initial} inventory={updated} relevant={updated} />);
    expect(cardTitles(container)).toEqual([
      'Alpha dinner',
      'Bravo dinner',
      'Zulu dinner',
      'Yankee dinner',
    ]);
    expect(screen.getByRole('combobox', { name: 'Sort by' })).toHaveTextContent('Most matches');
    await choose(user, 'Sort by', 'Name');
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
    await chooseFilter(user, 'Recipe source', 'RecipeAPI.io');
    await user.type(screen.getByRole('textbox', { name: 'Find recipes' }), 'dinner');
    await user.click(screen.getByRole('button', { name: 'Search RecipeAPI.io' }));
    await screen.findByText('4 recipes loaded · 4 match your filters.');
    expect(searchRecipeProviders).toHaveBeenCalledOnce();
    await choose(user, 'Sort by', 'Most matches');
    expect(cardTitles(container)).toEqual([
      'Alpha dinner',
      'Zulu dinner',
      'Yankee dinner',
      'Bravo dinner',
    ]);
    expect(screen.getByText(/Showing 4 of 4 recipes · RecipeAPI.io/)).toBeVisible();
    expect(searchRecipeProviders).toHaveBeenCalledOnce();
  });

  it('applies drawer filters live, removes them individually, and clears filters without losing the search or sort', async () => {
    const user = userEvent.setup();
    const { container } = render(<RecipeBrowser {...props()} />);
    await screen.findByText(/Showing 4 of 4 recipes/);
    await user.type(screen.getByRole('textbox', { name: 'Find recipes' }), 'dinner');
    await choose(user, 'Sort by', 'Most matches');
    await user.click(screen.getByRole('button', { name: 'Filters (1)' }));
    await choose(user, 'Recipe category', 'Soup');
    const drawer = screen.getByRole('dialog', { name: 'Filter recipes' });
    expect(drawer).toBeVisible();
    expect(within(drawer).queryByRole('heading', { name: 'Availability' })).not.toBeInTheDocument();
    expect(within(drawer).queryByRole('heading', { name: 'Your kitchen' })).not.toBeInTheDocument();
    expect(within(drawer).getByRole('heading', { name: 'Category & cuisine' })).toBeVisible();
    expect(
      within(drawer).getByRole('checkbox', { name: 'Prioritize expiring ingredients' }),
    ).toBeVisible();
    expect(cardTitles(container)).toEqual(['Zulu dinner']);
    await user.click(screen.getByRole('button', { name: 'Show recipes' }));
    expect(screen.getByRole('button', { name: 'Filters (2)' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Remove Soup filter' }));
    expect(cardTitles(container)).toEqual([
      'Alpha dinner',
      'Zulu dinner',
      'Yankee dinner',
      'Bravo dinner',
    ]);
    expect(screen.getByRole('button', { name: 'Remove Saved recipes filter' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(screen.getByRole('textbox', { name: 'Find recipes' })).toHaveValue('dinner');
    expect(screen.getByRole('combobox', { name: 'Sort by' })).toHaveTextContent('Most matches');
    expect(screen.getByRole('button', { name: 'Filters' })).toBeVisible();
    expect(screen.queryByRole('group', { name: 'Active recipe filters' })).not.toBeInTheDocument();
    expect(searchRecipeProviders).not.toHaveBeenCalled();
  });

  it('keeps online source and loaded results when Clear all removes category filters', async () => {
    vi.mocked(searchRecipeProviders).mockResolvedValue({
      provider: 'recipeapi',
      storage: 'personal',
      recipes,
      page: 1,
      hasMore: false,
      warnings: [],
    });
    saveGeminiConnection({ url: 'https://mise.example.workers.dev', token: 'a'.repeat(43) });
    const user = userEvent.setup();
    render(<RecipeBrowser {...props()} />);
    await screen.findByText(/Showing 4 of 4 recipes/);
    await chooseFilter(user, 'Recipe source', 'RecipeAPI.io');
    await user.type(screen.getByRole('textbox', { name: 'Find recipes' }), 'dinner');
    await user.click(screen.getByRole('button', { name: 'Search RecipeAPI.io' }));
    await screen.findByText('4 recipes loaded · 4 match your filters.');
    await chooseFilter(user, 'Recipe category', 'Soup');
    expect(screen.getByText('4 recipes loaded · 1 match your filters.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(screen.getByRole('textbox', { name: 'Find recipes' })).toHaveValue('dinner');
    expect(screen.getByRole('button', { name: 'Search RecipeAPI.io' })).toBeVisible();
    expect(screen.getByText('4 recipes loaded · 4 match your filters.')).toBeVisible();
    expect(searchRecipeProviders).toHaveBeenCalledOnce();
  });

  it('offers the community cookbook when Saved recipes is empty and retains attribution', async () => {
    vi.mocked(loadLocalRecipes).mockResolvedValueOnce([
      { ...recipes[0], source: { type: 'wikibooks' } },
    ]);
    const kitchen = { ...inventory(), recipes: [] };
    const user = userEvent.setup();
    render(<RecipeBrowser {...props(kitchen)} />);
    expect(
      await screen.findByRole('heading', { name: 'Your favorites start here.' }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Remove Saved recipes filter' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Browse all recipes' }));
    expect(screen.getByRole('heading', { name: 'Alpha dinner' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Wikibooks contributors' })).toHaveAttribute(
      'href',
      'https://en.wikibooks.org/wiki/Cookbook:Table_of_Contents',
    );
    expect(screen.getByRole('link', { name: 'CC BY-SA 4.0' })).toHaveAttribute(
      'href',
      'https://creativecommons.org/licenses/by-sa/4.0/',
    );
    expect(searchRecipeProviders).not.toHaveBeenCalled();
  });
});
