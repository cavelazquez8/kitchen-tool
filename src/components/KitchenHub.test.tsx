import { useSyncExternalStore } from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyInventory, type InventoryState } from '../domain/types';
import { createLocalRepository, LOCAL_STORAGE_KEY } from '../lib/localRepository';
import type { InventoryRepository } from '../lib/repository';
import { loadLocalRecipes } from '../recipes/localLibrary';
import type { Recipe } from '../recipes/types';
import { KitchenHub, type HubPage } from './KitchenHub';

vi.mock('../recipes/localLibrary', () => ({
  loadLocalRecipes: vi.fn().mockResolvedValue([]),
  recipeFacets: () => ({ categories: [], cuisines: [] }),
  searchLocalRecipes: (recipes: Recipe[]) => recipes,
}));

const imported: Recipe = {
  id: 'imported:carrot-soup',
  title: 'Carrot soup',
  servings: 2,
  ingredients: [{ name: 'Carrots', quantity: 200, unit: 'g' }],
  steps: ['Simmer the carrots.'],
  source: { type: 'imported', url: 'https://example.com/carrot-soup' },
};
const other: Recipe = {
  ...imported,
  id: 'manual:other',
  title: 'Other recipe',
  source: { type: 'manual' },
};
const builtIn: Recipe = {
  ...imported,
  id: 'wikibooks:rice',
  title: 'Built-in rice',
  source: { type: 'wikibooks' },
};

function renderKitchen(
  repository: InventoryRepository,
  update = vi.fn(repository.update),
  page: HubPage = 'recipes',
) {
  const toast = vi.fn();
  function Kitchen() {
    const { state } = useSyncExternalStore(repository.subscribe, repository.getSnapshot);
    return (
      <KitchenHub
        page={page}
        inventory={state}
        selectedBatchIds={[]}
        update={update}
        onToast={toast}
        onQuickAdd={vi.fn()}
        onScan={vi.fn()}
        onConfigure={vi.fn()}
        onNavigate={vi.fn()}
      />
    );
  }
  return { ...render(<Kitchen />), update, toast };
}

function setup(inventory: InventoryState, page: HubPage = 'recipes') {
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, state: inventory }));
  const repository = createLocalRepository(localStorage);
  return { repository, ...renderKitchen(repository, vi.fn(repository.update), page) };
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(loadLocalRecipes).mockReset().mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('imported recipe deletion', () => {
  it('keeps a cancelled import and removes only the confirmed recipe and its plan references across reloads', async () => {
    vi.mocked(loadLocalRecipes).mockResolvedValue([builtIn]);
    const inventory: InventoryState = {
      ...createEmptyInventory(),
      recipes: [imported, other],
      mealPlan: [
        { recipeId: imported.id, servings: 2 },
        { recipeId: other.id, servings: 4 },
      ],
      shoppingList: [
        {
          id: 'recipe:carrots',
          name: 'Carrots',
          quantity: 1,
          unit: 'kg',
          checked: false,
          status: 'missing',
        },
        {
          id: 'manual:milk',
          name: 'Milk',
          quantity: 1,
          unit: 'bottle',
          checked: true,
          status: 'missing',
        },
      ],
    };
    const { repository, update, toast, unmount } = setup(inventory);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: imported.title }));
    const detail = screen.getByRole('dialog', { name: imported.title });
    await user.click(within(detail).getByRole('button', { name: 'Delete recipe' }));
    let confirmation = screen.getByRole('dialog', { name: 'Delete “Carrot soup”?' });
    expect(confirmation).toHaveTextContent('from your library and meal plan');
    await user.click(within(confirmation).getByRole('button', { name: 'Keep recipe' }));
    expect(detail).toBeVisible();
    expect(repository.getSnapshot().state).toEqual(inventory);
    expect(update).not.toHaveBeenCalled();

    await user.click(within(detail).getByRole('button', { name: 'Delete recipe' }));
    confirmation = screen.getByRole('dialog', { name: 'Delete “Carrot soup”?' });
    await user.click(within(confirmation).getByRole('button', { name: 'Delete recipe' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(repository.getSnapshot().state.recipes).toEqual([other]);
    expect(repository.getSnapshot().state.mealPlan).toEqual([{ recipeId: other.id, servings: 4 }]);
    expect(repository.getSnapshot().state.shoppingList).toEqual(inventory.shoppingList);
    expect(update).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('Recipe deleted.');
    expect(screen.queryByRole('heading', { name: imported.title })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: builtIn.title })).toBeVisible();

    unmount();
    const restored = createLocalRepository(localStorage);
    renderKitchen(restored);
    expect(await screen.findByRole('heading', { name: other.title })).toBeVisible();
    expect(screen.queryByRole('heading', { name: imported.title })).not.toBeInTheDocument();
    expect(restored.getSnapshot().state.recipes).toEqual([other]);
  });

  it('offers deletion for saved RecipeAPI imports', async () => {
    const recipe: Recipe = {
      ...imported,
      id: 'recipeapi:12',
      title: 'Saved RecipeAPI soup',
      source: { type: 'imported', name: 'RecipeAPI.io' },
    };
    const { repository } = setup({ ...createEmptyInventory(), recipes: [recipe] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: recipe.title }));
    await user.click(
      within(screen.getByRole('dialog', { name: recipe.title })).getByRole('button', {
        name: 'Delete recipe',
      }),
    );
    const confirmation = screen.getByRole('dialog', { name: 'Delete “Saved RecipeAPI soup”?' });
    expect(confirmation).not.toHaveTextContent('meal plan');
    await user.click(within(confirmation).getByRole('button', { name: 'Delete recipe' }));
    await waitFor(() => expect(repository.getSnapshot().state.recipes).toEqual([]));
  });

  it('never offers full deletion for built-in or unsaved discovered recipes', async () => {
    const discovered: Recipe = {
      ...imported,
      id: 'recipeapi:unsaved',
      title: 'Unsaved recipe',
      source: { type: 'imported', name: 'RecipeAPI.io' },
    };
    vi.mocked(loadLocalRecipes).mockResolvedValue([builtIn, discovered]);
    const { repository, update } = setup({ ...createEmptyInventory(), recipes: [builtIn] });
    const user = userEvent.setup();
    for (const recipe of [builtIn, discovered]) {
      await user.click(await screen.findByRole('button', { name: recipe.title }));
      const detail = screen.getByRole('dialog', { name: recipe.title });
      expect(
        within(detail).queryByRole('button', { name: 'Delete recipe' }),
      ).not.toBeInTheDocument();
      await user.click(within(detail).getByRole('button', { name: 'Close' }));
    }
    expect(update).not.toHaveBeenCalled();
    expect(repository.getSnapshot().state.recipes).toEqual([builtIn]);
  });

  it('removes a saved cookbook recipe and plan reference while retaining the bundled version', async () => {
    vi.mocked(loadLocalRecipes).mockResolvedValue([builtIn]);
    const { repository } = setup({
      ...createEmptyInventory(),
      recipes: [builtIn, imported],
      mealPlan: [{ recipeId: builtIn.id, servings: 2 }],
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Saved recipes' }));
    await user.click(
      screen.getByRole('button', { name: `Remove ${builtIn.title} from saved recipes` }),
    );
    const confirmation = screen.getByRole('dialog', {
      name: `Remove “${builtIn.title}” from saved recipes?`,
    });
    await user.click(within(confirmation).getByRole('button', { name: 'Remove recipe' }));
    await waitFor(() => expect(repository.getSnapshot().state.recipes).toEqual([imported]));
    expect(repository.getSnapshot().state.mealPlan).toEqual([]);
    expect(screen.queryByRole('heading', { name: builtIn.title })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'All recipes' }));
    expect(await screen.findByRole('heading', { name: builtIn.title })).toBeVisible();
  });

  it('clears every shopping-list item only after confirmation and preserves kitchen data', async () => {
    const inventory: InventoryState = {
      ...createEmptyInventory(),
      recipes: [imported],
      mealPlan: [{ recipeId: imported.id, servings: 2 }],
      shoppingList: [
        {
          id: 'manual:1',
          name: 'Milk',
          quantity: 1,
          unit: 'bottle',
          checked: true,
          status: 'missing',
        },
        {
          id: 'recipe:2',
          name: 'Carrots',
          quantity: 100,
          unit: 'g',
          checked: false,
          status: 'missing',
        },
      ],
    };
    const { repository, update } = setup(inventory, 'shopping');
    const user = userEvent.setup();
    expect(document.querySelector('.quick-foods')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    let review = screen.getByRole('dialog', { name: 'Clear shopping list?' });
    await user.click(within(review).getByRole('button', { name: 'Keep list' }));
    expect(update).not.toHaveBeenCalled();
    expect(repository.getSnapshot().state).toEqual(inventory);
    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    review = screen.getByRole('dialog', { name: 'Clear shopping list?' });
    await user.click(within(review).getByRole('button', { name: 'Clear all items' }));
    await waitFor(() => expect(repository.getSnapshot().state.shoppingList).toEqual([]));
    expect(repository.getSnapshot().state).toEqual({ ...inventory, shoppingList: [] });
    expect(createLocalRepository(localStorage).getSnapshot().state.shoppingList).toEqual([]);
  });

  it('retains the recipe and review when saving the deletion fails', async () => {
    const repository = createLocalRepository(localStorage);
    await repository.replace({ ...createEmptyInventory(), recipes: [imported] });
    const update = vi.fn().mockRejectedValue(new Error('Browser storage is full.'));
    renderKitchen(repository, update);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: imported.title }));
    await user.click(
      within(screen.getByRole('dialog', { name: imported.title })).getByRole('button', {
        name: 'Delete recipe',
      }),
    );
    const confirmation = screen.getByRole('dialog', { name: 'Delete “Carrot soup”?' });
    await user.click(within(confirmation).getByRole('button', { name: 'Delete recipe' }));
    expect(await within(confirmation).findByRole('alert')).toHaveTextContent(
      'Browser storage is full.',
    );
    expect(repository.getSnapshot().state.recipes).toEqual([imported]);
    expect(within(confirmation).getByRole('button', { name: 'Delete recipe' })).toBeEnabled();
    await user.click(within(confirmation).getByRole('button', { name: 'Keep recipe' }));
    expect(screen.getByRole('dialog', { name: imported.title })).toBeVisible();
  });

  it('checks the latest saved record before removing an import', async () => {
    const { repository } = setup({ ...createEmptyInventory(), recipes: [imported] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: imported.title }));
    await user.click(
      within(screen.getByRole('dialog', { name: imported.title })).getByRole('button', {
        name: 'Delete recipe',
      }),
    );
    const confirmation = screen.getByRole('dialog', { name: 'Delete “Carrot soup”?' });
    const replacement: Recipe = { ...builtIn, id: imported.id };
    await repository.replace({ ...createEmptyInventory(), recipes: [replacement] });
    await user.click(within(confirmation).getByRole('button', { name: 'Delete recipe' }));
    expect(await within(confirmation).findByRole('alert')).toHaveTextContent(
      'no longer a saved import',
    );
    expect(repository.getSnapshot().state.recipes).toEqual([replacement]);
  });
});
