import { useSyncExternalStore } from 'react';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyInventory, type InventoryState } from '../domain/types';
import { createLocalRepository, LOCAL_STORAGE_KEY } from '../lib/localRepository';
import type { InventoryRepository } from '../lib/repository';
import { loadLocalRecipes } from '../recipes/localLibrary';
import type { Recipe } from '../recipes/types';
import { readGeminiConnection, sendGeminiChat, type AiReply } from '../ai/client';
import { KitchenHub, type HubPage } from './KitchenHub';

vi.mock('../recipes/localLibrary', () => ({
  loadLocalRecipes: vi.fn().mockResolvedValue([]),
  recipeFacets: () => ({ categories: [], cuisines: [] }),
  searchLocalRecipes: (recipes: Recipe[]) => recipes,
}));
vi.mock('../ai/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai/client')>()),
  readGeminiConnection: vi.fn(),
  sendGeminiChat: vi.fn(),
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
  vi.mocked(readGeminiConnection).mockReset().mockReturnValue(null);
  vi.mocked(sendGeminiChat).mockReset();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('inventory attached to Gemini messages', () => {
  const stocked: InventoryState = {
    products: [
      {
        id: 'carrots',
        name: 'Selected Orchard Carrots',
        ingredientName: 'Carrots',
        isStaple: false,
      },
      { id: 'milk', name: 'Private Meadow Milk', ingredientName: 'Milk', isStaple: false },
    ],
    batches: [
      {
        id: 'carrot-stock',
        productId: 'carrots',
        location: 'fridge',
        quantity: 100,
        unit: 'g',
        purchasedOn: '2026-10-14',
        expiresOn: null,
      },
      {
        id: 'milk-stock',
        productId: 'milk',
        location: 'fridge',
        quantity: 2,
        unit: 'cup',
        purchasedOn: '2026-10-14',
        expiresOn: null,
      },
    ],
    tools: [{ id: 'mixer', name: 'Private Stand Mixer' }],
    recipes: [imported],
  };

  for (const mode of ['all', 'selected', 'none'] as const) {
    it(`uses the ${mode} inventory choice in the actual chat request`, async () => {
      vi.mocked(readGeminiConnection).mockReturnValue({
        url: 'https://mise.example.workers.dev',
        token: 'a'.repeat(32),
      });
      vi.mocked(sendGeminiChat).mockResolvedValue({
        message: 'Let’s discuss this recipe.',
        recipes: [],
        warnings: [],
        recommendedRecipeIds: [],
      });
      const { repository } = setup(
        {
          ...stocked,
          assistantSession: {
            recipes: [imported],
            attachedRecipes: [],
            draft: '',
            mode: 'discover',
            inventoryContext: { mode, productIds: ['carrots'] },
          },
        },
        'assistant',
      );
      const user = userEvent.setup();
      await user.type(
        screen.getByRole('textbox', { name: 'Message Gemini' }),
        'Tell me about carrot soup.',
      );
      await user.click(screen.getByRole('button', { name: 'Ask Gemini' }));
      await waitFor(() => expect(sendGeminiChat).toHaveBeenCalledOnce());
      const request = vi.mocked(sendGeminiChat).mock.calls[0][1];
      const payload = JSON.stringify(request);
      if (mode === 'all') {
        expect(request.inventory).toContain('Selected Orchard Carrots');
        expect(request.inventory).toContain('Private Meadow Milk');
        expect(request.inventory).toContain('Private Stand Mixer');
        expect(request.candidates?.[0].missingIngredients).toContain('Carrots');
      } else {
        expect(payload).not.toContain('Private Meadow Milk');
        expect(payload).not.toContain('Private Stand Mixer');
        expect(request.candidates?.[0].missingIngredients).toEqual([]);
        if (mode === 'selected') expect(request.inventory).toContain('Selected Orchard Carrots');
        else {
          expect(payload).not.toContain('Selected Orchard Carrots');
          expect(request.inventory).toContain('Inventory not shared');
        }
      }
      expect(repository.getSnapshot().state.batches).toEqual(stocked.batches);
      await screen.findByText('Let’s discuss this recipe.');
    });
  }

  for (const mode of ['selected', 'none'] as const) {
    it(`copies only the ${mode} inventory context for manual chat`, async () => {
      const user = userEvent.setup();
      const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
      setup(
        {
          ...stocked,
          assistantSession: {
            recipes: [],
            attachedRecipes: [],
            draft: '',
            mode: 'discover',
            inventoryContext: { mode, productIds: ['carrots'] },
          },
        },
        'assistant',
      );
      await user.click(screen.getByRole('button', { name: 'Copy kitchen context' }));
      expect(writeText).toHaveBeenCalledOnce();
      const copied = writeText.mock.calls[0][0];
      expect(copied).not.toContain('Private Meadow Milk');
      expect(copied).not.toContain('Private Stand Mixer');
      if (mode === 'selected') expect(copied).toContain('Selected Orchard Carrots');
      else {
        expect(copied).not.toContain('Selected Orchard Carrots');
        expect(copied).toContain('Inventory not shared');
      }
      writeText.mockRestore();
    });
  }

  it('keeps no-inventory selected when starting a fresh conversation', async () => {
    const { repository } = setup(
      {
        ...stocked,
        chatHistory: [{ id: 'hello', role: 'assistant', text: 'Hello there.' }],
        assistantSession: {
          recipes: [],
          attachedRecipes: [],
          draft: '',
          mode: 'discover',
          inventoryContext: { mode: 'none', productIds: [] },
        },
      },
      'assistant',
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Conversation options' }));
    await user.click(screen.getByRole('button', { name: 'Clear conversation' }));
    const dialog = screen.getByRole('dialog', { name: 'Clear conversation?' });
    await user.click(within(dialog).getByRole('button', { name: 'Clear conversation' }));
    await waitFor(() => expect(repository.getSnapshot().state.chatHistory).toEqual([]));
    expect(repository.getSnapshot().state.assistantSession?.inventoryContext?.mode).toBe('none');
    expect(screen.getByRole('button', { name: 'Inventory context' })).toHaveTextContent(
      'No inventory',
    );
  });
});

describe('a conversation that leads to groceries', () => {
  const publisherRecipe: Recipe = {
    ...imported,
    ingredients: [...imported.ingredients, { name: 'Onion', quantity: 1, unit: 'each' }],
    source: {
      type: 'imported',
      name: 'Recipe publisher',
      url: 'https://example.com/carrot-soup',
      attribution: 'Recipe publisher · Ada Cook',
    },
    author: 'Ada Cook',
    totalMinutes: 25,
    imageUrl: 'https://example.com/carrot-soup.jpg',
    publisherNutrition: { servingSize: '1 bowl', calories: '230 kcal', protein: '12 g' },
  };
  function connect() {
    vi.mocked(readGeminiConnection).mockReturnValue({
      url: 'https://mise.example.workers.dev',
      token: 'a'.repeat(32),
    });
  }

  it('retains original recipe cards, chosen context and the draft after leaving the assistant or reloading', async () => {
    connect();
    vi.mocked(sendGeminiChat).mockResolvedValue({
      message: 'This soup is a useful option. You can buy the onion.',
      recipes: [],
      warnings: [],
      sourceRecipes: [publisherRecipe],
      recommendedRecipeIds: [publisherRecipe.id],
    });
    const { repository, unmount } = setup(createEmptyInventory(), 'assistant');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Help me choose dinner/ }));
    expect(await screen.findByRole('heading', { name: publisherRecipe.title })).toBeVisible();
    expect(screen.getByText('25 minutes')).toBeVisible();
    expect(screen.getByText('By Ada Cook')).toBeVisible();
    expect(vi.mocked(sendGeminiChat).mock.calls[0][1]).toMatchObject({ discover: true });
    expect(vi.mocked(sendGeminiChat).mock.calls[0][1].message).toContain('happy to shop');
    expect(repository.getSnapshot().state.assistantSession?.recipes).toEqual([publisherRecipe]);
    await user.click(screen.getByRole('button', { name: 'Ask about this recipe' }));
    await waitFor(() =>
      expect(repository.getSnapshot().state.assistantSession?.draft).toContain(
        publisherRecipe.title,
      ),
    );
    expect(repository.getSnapshot().state.assistantSession?.attachedRecipes).toEqual([
      publisherRecipe,
    ]);
    const snapshot = repository.getSnapshot().state;
    unmount();
    const restored = createLocalRepository(localStorage);
    const next = renderKitchen(restored, vi.fn(restored.update), 'assistant');
    expect(await screen.findByRole('heading', { name: publisherRecipe.title })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Message Gemini' })).toHaveValue(
      snapshot.assistantSession?.draft,
    );
    expect(
      screen.getByRole('button', { name: 'Remove Carrot soup from Gemini context' }),
    ).toBeVisible();
    vi.mocked(sendGeminiChat).mockResolvedValue({
      message: 'It reheats well. Keep the original quantities.',
      recipes: [],
      warnings: [],
    });
    await user.clear(screen.getByRole('textbox', { name: 'Message Gemini' }));
    await user.type(
      screen.getByRole('textbox', { name: 'Message Gemini' }),
      'Does this reheat well?',
    );
    await user.click(screen.getByRole('button', { name: 'Ask Gemini' }));
    await screen.findByText('It reheats well. Keep the original quantities.');
    const request = vi.mocked(sendGeminiChat).mock.calls[1][1];
    expect(request.recipe).toContain('200 g: Carrots');
    expect(request.recipe).toContain('1 bowl');
    expect(request.candidates?.some((recipe) => recipe.id === publisherRecipe.id)).toBe(true);
    expect(screen.getByRole('heading', { name: publisherRecipe.title })).toBeVisible();
    expect(restored.getSnapshot().state.assistantSession?.recipes).toEqual([publisherRecipe]);
    next.unmount();
  });

  it('keeps the draft and previous recipe options when a request fails, and retries without duplicating the user turn', async () => {
    connect();
    vi.mocked(sendGeminiChat).mockRejectedValueOnce(new Error('Gemini took too long. Try again.'));
    const inventory: InventoryState = {
      ...createEmptyInventory(),
      assistantSession: {
        recipes: [publisherRecipe],
        attachedRecipes: [],
        draft: 'Can I freeze this?',
        mode: 'discover',
      },
    };
    const { repository } = setup(inventory, 'assistant');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Ask Gemini' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Gemini took too long');
    expect(screen.getByRole('textbox', { name: 'Message Gemini' })).toHaveValue(
      'Can I freeze this?',
    );
    expect(screen.getByRole('heading', { name: publisherRecipe.title })).toBeVisible();
    vi.mocked(sendGeminiChat).mockResolvedValueOnce({
      message: 'You can freeze it after cooling.',
      recipes: [],
      warnings: [],
    });
    await user.click(screen.getByRole('button', { name: 'Ask Gemini' }));
    await screen.findByText('You can freeze it after cooling.');
    expect(
      repository.getSnapshot().state.chatHistory?.filter((turn) => turn.role === 'user'),
    ).toHaveLength(1);
    expect(repository.getSnapshot().state.assistantSession?.draft).toBe('');
  });
  it('keeps one request active across navigation and displays its reply without clearing a newer draft', async () => {
    connect();
    let finish!: (reply: AiReply) => void;
    vi.mocked(sendGeminiChat).mockImplementationOnce(
      () =>
        new Promise<AiReply>((resolve) => {
          finish = resolve;
        }),
    );
    const { repository, unmount } = setup(createEmptyInventory(), 'assistant');
    const user = userEvent.setup();
    await user.type(
      screen.getByRole('textbox', { name: 'Message Gemini' }),
      'Help me choose dinner',
    );
    await user.click(screen.getByRole('button', { name: 'Ask Gemini' }));
    await waitFor(() => expect(sendGeminiChat).toHaveBeenCalledTimes(1));
    unmount();
    renderKitchen(repository, vi.fn(repository.update), 'assistant');
    expect(screen.getByRole('textbox', { name: 'Message Gemini' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Gemini is thinking' })).toBeDisabled();
    await act(async () => {
      await repository.update((state) => ({
        ...state,
        assistantSession: { ...state.assistantSession!, draft: 'What about next week?' },
      }));
      finish({
        message: 'Here is a real recipe to start with.',
        recipes: [],
        warnings: [],
        sourceRecipes: [publisherRecipe],
        recommendedRecipeIds: [publisherRecipe.id],
      });
    });
    expect(await screen.findByText('Here is a real recipe to start with.')).toBeVisible();
    expect(await screen.findByRole('heading', { name: publisherRecipe.title })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Message Gemini' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'Message Gemini' })).toHaveValue(
      'What about next week?',
    );
    expect(repository.getSnapshot().state.assistantSession?.draft).toBe('What about next week?');
    expect(sendGeminiChat).toHaveBeenCalledTimes(1);
  });

  it('chooses portions and creates the shopping list directly without buying the recorded stock twice', async () => {
    const inventory: InventoryState = {
      ...createEmptyInventory(),
      products: [
        {
          id: 'carrots',
          name: 'Store brand baby carrots',
          ingredientName: 'Carrots',
          isStaple: false,
        },
      ],
      batches: [
        {
          id: 'batch',
          productId: 'carrots',
          quantity: 100,
          unit: 'g',
          location: 'fridge',
          purchasedOn: '2026-10-13',
          expiresOn: null,
        },
      ],
      assistantSession: {
        recipes: [publisherRecipe],
        attachedRecipes: [],
        draft: '',
        mode: 'discover',
      },
    };
    const { repository, unmount } = setup(inventory, 'assistant');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Choose recipe' }));
    const detail = screen.getByRole('dialog', { name: publisherRecipe.title });
    expect(within(detail).getByText('230 kcal')).toBeVisible();
    const portions = within(detail).getByRole('spinbutton', { name: /Cooking for/ });
    await user.clear(portions);
    await user.type(portions, '4');
    await user.click(within(detail).getByRole('button', { name: 'Make shopping list' }));
    await waitFor(() => expect(repository.getSnapshot().state.shoppingList).toHaveLength(2));
    const state = repository.getSnapshot().state;
    expect(state.recipes).toEqual([publisherRecipe]);
    expect(state.mealPlan).toEqual([{ recipeId: publisherRecipe.id, servings: 4 }]);
    expect(state.shoppingList).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Carrots', quantity: 300, unit: 'g' }),
        expect.objectContaining({ name: 'Onion', quantity: 2, unit: 'each' }),
      ]),
    );
    expect(state.batches).toEqual(inventory.batches);
    unmount();
    const restored = createLocalRepository(localStorage);
    renderKitchen(restored, vi.fn(restored.update), 'shopping');
    expect(await screen.findByRole('heading', { name: 'What to buy' })).toBeVisible();
    expect(screen.getByText('300 g')).toBeVisible();
    expect(restored.getSnapshot().state.mealPlan).toEqual(state.mealPlan);
  });
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
    await user.click(screen.getByRole('button', { name: 'All recipes' }));
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
    await user.click(screen.getByRole('button', { name: 'All recipes' }));
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
