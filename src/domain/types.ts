import { isRecipe, type Recipe } from '../recipes/types';
export type StorageLocation = 'fridge' | 'freezer' | 'pantry';
export type StapleStatus = 'stocked' | 'low' | 'empty';

export interface Product {
  id: string;
  name: string;
  barcode?: string;
  brand?: string;
  isStaple: boolean;
  ingredientName?: string;
  /** Reviewed original package contents, independent of a batch's remaining stock. */
  packageQuantity?: { quantity: number; unit: string };
}

export interface Batch {
  id: string;
  productId: string;
  location: StorageLocation;
  quantity: number | null;
  unit: string;
  purchasedOn: string;
  expiresOn: string | null;
  stapleStatus?: StapleStatus;
}

export interface Tool {
  id: string;
  name: string;
}

export interface ShoppingItem {
  id: string;
  name: string;
  quantity: number | null;
  unit: string;
  checked: boolean;
  status: 'missing' | 'check';
  note?: string;
  addedBatchId?: string;
}
export interface MealPlanItem {
  recipeId: string;
  servings: number | null;
}
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}
export interface InventoryState {
  products: Product[];
  batches: Batch[];
  tools: Tool[];
  recipes?: Recipe[];
  mealPlan?: MealPlanItem[];
  shoppingList?: ShoppingItem[];
  chatHistory?: ChatMessage[];
}

export interface InventoryGroup {
  id: string;
  product: Product;
  location: StorageLocation;
  batches: Batch[];
  quantity: number | null;
  unit: string;
  hasUnknownQuantity: boolean;
  hasMixedUnits: boolean;
}

export const STORAGE_LOCATIONS: readonly StorageLocation[] = ['fridge', 'freezer', 'pantry'];
export const LOCATION_LABELS: Record<StorageLocation, string> = {
  fridge: 'Fridge',
  freezer: 'Freezer',
  pantry: 'Pantry',
};

export function createEmptyInventory(): InventoryState {
  return { products: [], batches: [], tools: [] };
}

/** A local calendar date, not a UTC timestamp. */
export function isDateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonemptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isOptionalText(value: unknown): boolean {
  return value === undefined || isNonemptyText(value);
}

/** Reject corrupted remote or imported data instead of silently coercing it. */
export function isInventoryState(value: unknown): value is InventoryState {
  if (
    !isRecord(value) ||
    !Array.isArray(value.products) ||
    !Array.isArray(value.batches) ||
    !Array.isArray(value.tools)
  )
    return false;
  const productIds = new Set<string>();
  for (const product of value.products) {
    if (
      !isRecord(product) ||
      !isNonemptyText(product.id) ||
      !isNonemptyText(product.name) ||
      typeof product.isStaple !== 'boolean' ||
      !isOptionalText(product.barcode) ||
      !isOptionalText(product.brand) ||
      !isOptionalText(product.ingredientName) ||
      !(
        product.packageQuantity === undefined ||
        (isRecord(product.packageQuantity) &&
          typeof product.packageQuantity.quantity === 'number' &&
          Number.isFinite(product.packageQuantity.quantity) &&
          product.packageQuantity.quantity > 0 &&
          isNonemptyText(product.packageQuantity.unit))
      ) ||
      productIds.has(product.id)
    )
      return false;
    productIds.add(product.id);
  }
  const batchIds = new Set<string>();
  for (const batch of value.batches) {
    if (
      !isRecord(batch) ||
      !isNonemptyText(batch.id) ||
      batchIds.has(batch.id) ||
      !isNonemptyText(batch.productId) ||
      !productIds.has(batch.productId) ||
      !STORAGE_LOCATIONS.includes(batch.location as StorageLocation) ||
      !(
        batch.quantity === null ||
        (typeof batch.quantity === 'number' &&
          Number.isFinite(batch.quantity) &&
          batch.quantity >= 0)
      ) ||
      typeof batch.unit !== 'string' ||
      !isDateOnly(batch.purchasedOn) ||
      !(batch.expiresOn === null || isDateOnly(batch.expiresOn)) ||
      !(
        batch.stapleStatus === undefined ||
        ['stocked', 'low', 'empty'].includes(batch.stapleStatus as string)
      )
    )
      return false;
    batchIds.add(batch.id);
  }
  const toolIds = new Set<string>();
  for (const tool of value.tools) {
    if (
      !isRecord(tool) ||
      !isNonemptyText(tool.id) ||
      toolIds.has(tool.id) ||
      !isNonemptyText(tool.name)
    )
      return false;
    toolIds.add(tool.id);
  }
  if (
    value.recipes !== undefined &&
    (!Array.isArray(value.recipes) ||
      !value.recipes.every(isRecipe) ||
      new Set(value.recipes.map((recipe) => recipe.id)).size !== value.recipes.length)
  )
    return false;
  if (
    value.mealPlan !== undefined &&
    (!Array.isArray(value.mealPlan) ||
      !value.mealPlan.every(
        (item) =>
          isRecord(item) &&
          isNonemptyText(item.recipeId) &&
          (item.servings === null ||
            (typeof item.servings === 'number' &&
              Number.isFinite(item.servings) &&
              item.servings > 0)),
      ))
  )
    return false;
  if (
    value.shoppingList !== undefined &&
    (!Array.isArray(value.shoppingList) ||
      !value.shoppingList.every(
        (item) =>
          isRecord(item) &&
          isNonemptyText(item.id) &&
          isNonemptyText(item.name) &&
          typeof item.unit === 'string' &&
          typeof item.checked === 'boolean' &&
          ['missing', 'check'].includes(item.status as string) &&
          (item.quantity === null ||
            (typeof item.quantity === 'number' &&
              Number.isFinite(item.quantity) &&
              item.quantity >= 0)) &&
          isOptionalText(item.note) &&
          isOptionalText(item.addedBatchId),
      ))
  )
    return false;
  if (
    value.chatHistory !== undefined &&
    (!Array.isArray(value.chatHistory) ||
      !value.chatHistory.every(
        (item) =>
          isRecord(item) &&
          isNonemptyText(item.id) &&
          ['user', 'assistant'].includes(item.role as string) &&
          isNonemptyText(item.text),
      ))
  )
    return false;
  return true;
}
