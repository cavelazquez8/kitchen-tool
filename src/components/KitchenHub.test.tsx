import { useSyncExternalStore } from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyInventory, type InventoryState } from '../domain/types';
import { createLocalRepository, LOCAL_STORAGE_KEY } from '../lib/localRepository';
import type { InventoryRepository } from '../lib/repository';
import { loadLocalRecipes } from '../recipes/localLibrary';
import type { Recipe } from '../recipes/types';
import { KitchenHub } from './KitchenHub';

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

function renderKitchen(repository: InventoryRepository, update = vi.fn(repository.update)) {
  const toast = vi.fn();
  function Kitchen() {
    const { state } = useSyncExternalStore(repository.subscribe, repository.getSnapshot);
    return (
      <KitchenHub
        page="recipes"
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

function setup(inventory: InventoryState) {
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, state: inventory }));
  const repository = createLocalRepository(localStorage);
  return { repository, ...renderKitchen(repository) };
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

  it('never offers deletion for built-in or unsaved discovered recipes', async () => {
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
