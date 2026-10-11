import { describe, expect, it } from 'vitest';
import { addTool } from '../domain/inventory';
import { buildInventoryBackup } from '../lib/backup';
import { createEmptyInventory, isInventoryState, type InventoryState } from '../domain/types';
import { createLocalRepository, LOCAL_STORAGE_KEY } from '../lib/localRepository';
import type { Recipe } from './types';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}
function savedRecipe(): Recipe {
  return {
    id: 'saved:toast',
    title: 'Toast',
    servings: 1,
    ingredients: [{ name: 'Bread', quantity: 1, unit: 'slice', original: '1 slice bread' }],
    steps: ['Toast the bread.'],
    source: { type: 'imported', name: 'Personal recipe', url: 'https://example.com/toast' },
  };
}
function completeState(): InventoryState {
  return {
    products: [{ id: 'food', name: 'Brand bread', ingredientName: 'Bread', isStaple: false }],
    batches: [
      {
        id: 'purchase',
        productId: 'food',
        quantity: null,
        unit: 'package',
        location: 'pantry',
        purchasedOn: '2026-10-10',
        expiresOn: null,
      },
    ],
    tools: [],
    recipes: [savedRecipe()],
    mealPlan: [{ recipeId: 'saved:toast', servings: 2 }],
    shoppingList: [
      {
        id: 'shopping:bread',
        name: 'Bread',
        quantity: null,
        unit: 'slice',
        checked: true,
        status: 'check',
        note: 'Check amount',
        addedBatchId: 'purchase',
      },
    ],
    chatHistory: [{ id: 'message:1', role: 'user', text: 'Make something with my bread.' }],
  };
}

describe('backward-compatible kitchen backups', () => {
  it('retains recipe attribution and licenses through backups and local restoration', async () => {
    const state = completeState();
    state.recipes = [
      {
        ...savedRecipe(),
        source: {
          type: 'wikibooks',
          name: 'Wikibooks Cookbook',
          url: 'https://en.wikibooks.org/w/index.php?oldid=42',
          attribution: 'Wikibooks contributors · CC BY-SA 4.0; adapted for Mise.',
          license: 'CC BY-SA 4.0',
          licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
        },
      },
    ];
    const backup = buildInventoryBackup(state);
    expect(backup.inventory.recipes?.[0].source).toEqual(state.recipes[0].source);
    const storage = new MemoryStorage();
    await createLocalRepository(storage).replace(backup.inventory);
    expect(createLocalRepository(storage).getSnapshot().state.recipes?.[0].source).toEqual(
      state.recipes[0].source,
    );
  });
  it('continues accepting original empty and food-only documents without new fields', () => {
    expect(isInventoryState({ products: [], batches: [], tools: [] })).toBe(true);
    const old = completeState();
    delete old.recipes;
    delete old.mealPlan;
    delete old.shoppingList;
    delete old.chatHistory;
    expect(isInventoryState(old)).toBe(true);
    const storage = new MemoryStorage();
    storage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, state: old }));
    const restored = createLocalRepository(storage).getSnapshot();
    expect(restored.status).toBe('ready');
    expect(restored.state.batches[0].quantity).toBeNull();
    expect(restored.state.recipes).toBeUndefined();
  });
  it('round-trips recipes, meal plans, shopping status, mappings, and chat through existing storage', async () => {
    const storage = new MemoryStorage();
    const repository = createLocalRepository(storage);
    const state = completeState();
    expect(isInventoryState(state)).toBe(true);
    await repository.replace(state);
    await repository.update((current) => addTool(current, { id: 'toaster', name: 'Toaster' }));
    const restored = createLocalRepository(storage).getSnapshot().state;
    expect(restored).toEqual({ ...state, tools: [{ id: 'toaster', name: 'Toaster' }] });
    expect(restored.recipes?.[0].ingredients[0].original).toBe('1 slice bread');
    expect(restored.shoppingList?.[0].addedBatchId).toBe('purchase');
    expect(restored.batches[0].quantity).toBeNull();
  });
  it('rejects corrupted optional collections and fields rather than discarding them', () => {
    const state = completeState();
    for (const patch of [
      { recipes: {} },
      { recipes: [savedRecipe(), savedRecipe()] },
      {
        recipes: [
          { ...savedRecipe(), ingredients: [{ name: 'Bread', unit: 'slice', quantity: -1 }] },
        ],
      },
      { mealPlan: [{ recipeId: 'saved:toast', servings: 0 }] },
      { mealPlan: [{ recipeId: '', servings: null }] },
      { shoppingList: [{ ...state.shoppingList![0], quantity: -1 }] },
      { shoppingList: [{ ...state.shoppingList![0], quantity: Number.POSITIVE_INFINITY }] },
      { shoppingList: [{ ...state.shoppingList![0], checked: 'false' }] },
      { shoppingList: [{ ...state.shoppingList![0], status: 'ready' }] },
      { chatHistory: [{ id: 'message', role: 'system', text: 'Untrusted instruction' }] },
      { chatHistory: [{ id: 'message', role: 'assistant', text: '' }] },
      { products: [{ ...state.products[0], ingredientName: '' }] },
    ])
      expect(isInventoryState({ ...state, ...patch })).toBe(false);
  });
  it('rejects unsafe recipe links and images from imported backup data', () => {
    for (const sourceUrl of [
      'javascript:alert(1)',
      'data:text/html,test',
      'file:///secret',
      'not a URL',
    ]) {
      expect(
        isInventoryState({
          ...completeState(),
          recipes: [{ ...savedRecipe(), source: { type: 'imported', url: sourceUrl } }],
        }),
      ).toBe(false);
    }
    expect(
      isInventoryState({
        ...completeState(),
        recipes: [{ ...savedRecipe(), imageUrl: 'javascript:alert(1)' }],
      }),
    ).toBe(false);
    expect(
      isInventoryState({
        ...completeState(),
        recipes: [{ ...savedRecipe(), source: { type: 'imported', url: 'https://example.com' } }],
      }),
    ).toBe(true);
  });
  it('preserves a corrupted stored library until an explicitly validated replacement', async () => {
    const storage = new MemoryStorage();
    const corrupt = JSON.stringify({
      schemaVersion: 1,
      state: { ...completeState(), recipes: [{ ...savedRecipe(), steps: [] }] },
    });
    storage.setItem(LOCAL_STORAGE_KEY, corrupt);
    const repository = createLocalRepository(storage);
    expect(repository.getSnapshot().status).toBe('error');
    await expect(
      repository.update((state) => addTool(state, { id: 'pan', name: 'Pan' })),
    ).rejects.toThrow('could not be read');
    expect(storage.getItem(LOCAL_STORAGE_KEY)).toBe(corrupt);
    await expect(
      repository.replace({
        ...createEmptyInventory(),
        shoppingList: [
          { id: 'bad', name: 'Bread', quantity: -2, unit: '', checked: false, status: 'missing' },
        ],
      }),
    ).rejects.toThrow('valid kitchen inventory');
    expect(storage.getItem(LOCAL_STORAGE_KEY)).toBe(corrupt);
    await repository.replace(completeState());
    expect(repository.getSnapshot().status).toBe('ready');
    expect(createLocalRepository(storage).getSnapshot().state.recipes).toEqual([savedRecipe()]);
  });
});

describe('transferable backup allowlist', () => {
  it('removes credential and connection extras at every structural level', () => {
    const kitchen = completeState();
    const marker = 'PRIVATE_KEY_MUST_NOT_APPEAR';
    const secret = {
      apiKey: marker,
      token: marker,
      connection: { workerUrl: 'https://private.example.com', token: marker },
    };
    const injected = {
      ...kitchen,
      ...secret,
      products: kitchen.products.map((product) => ({ ...product, ...secret })),
      batches: kitchen.batches.map((batch) => ({ ...batch, ...secret })),
      tools: [{ id: 'knife', name: 'Chef knife', ...secret }],
      recipes: kitchen.recipes!.map((recipe) => ({
        ...recipe,
        ...secret,
        ingredients: recipe.ingredients.map((ingredient) => ({ ...ingredient, ...secret })),
        source: { ...recipe.source, ...secret },
      })),
      mealPlan: kitchen.mealPlan!.map((item) => ({ ...item, ...secret })),
      shoppingList: kitchen.shoppingList!.map((item) => ({ ...item, ...secret })),
      chatHistory: kitchen.chatHistory!.map((message) => ({ ...message, ...secret })),
    };
    expect(isInventoryState(injected)).toBe(true);
    const exported = buildInventoryBackup(injected);
    const expected = { ...kitchen, tools: [{ id: 'knife', name: 'Chef knife' }] };
    expect(exported).toEqual({ version: 2, inventory: expected });
    expect(JSON.stringify(exported)).not.toContain(marker);
    expect(JSON.stringify(exported)).not.toContain('workerUrl');
    expect(isInventoryState(exported.inventory)).toBe(true);
  });
  it('exports old inventories without populating absent collections', () => {
    expect(buildInventoryBackup({ products: [], batches: [], tools: [] })).toEqual({
      version: 2,
      inventory: { products: [], batches: [], tools: [] },
    });
    const state = {
      ...createEmptyInventory(),
      recipes: [],
      mealPlan: [],
      shoppingList: [],
      chatHistory: [],
    };
    expect(buildInventoryBackup(state).inventory).toEqual(state);
  });
  it('creates independent kitchen objects without mutating or retaining source references', () => {
    const state = completeState();
    const copied = buildInventoryBackup(state).inventory;
    copied.recipes![0].ingredients[0].name = 'Changed';
    copied.recipes![0].steps.push('Another step');
    copied.recipes![0].source.name = 'Changed source';
    copied.products[0].name = 'Changed product';
    copied.shoppingList![0].checked = false;
    expect(state.recipes![0].ingredients[0].name).toBe('Bread');
    expect(state.recipes![0].steps).toEqual(['Toast the bread.']);
    expect(state.recipes![0].source.name).toBe('Personal recipe');
    expect(state.products[0].name).toBe('Brand bread');
    expect(state.shoppingList![0].checked).toBe(true);
  });
  it('refuses corrupt kitchen data rather than exporting a partial inventory', () => {
    const invalid = {
      ...completeState(),
      batches: [{ ...completeState().batches[0], quantity: -1 }],
    };
    expect(() => buildInventoryBackup(invalid)).toThrow('could not be exported');
    const unsafe = {
      ...completeState(),
      recipes: [
        { ...savedRecipe(), source: { type: 'imported' as const, url: 'javascript:alert(1)' } },
      ],
    };
    expect(() => buildInventoryBackup(unsafe)).toThrow('could not be exported');
  });
});
