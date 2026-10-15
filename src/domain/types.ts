import { isRecipe, type Recipe } from '../recipes/types';
import {
  isNutritionTargets,
  isRecipeNutritionMapping,
  type NutritionTargets,
  type RecipeNutritionMapping,
} from '../nutrition/types';
import { isBodyScanCollection, type BodyScan } from '../profile/types';
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
/** Controls only the inventory shared with the assistant, never the kitchen itself. */
export interface AssistantInventoryContext {
  mode: 'all' | 'selected' | 'none';
  productIds: string[];
}
export const MAX_ASSISTANT_INVENTORY_PRODUCTS = 1000;
export const MAX_ASSISTANT_PRODUCT_ID_LENGTH = 100;
/** Conversation cards and chosen context travel with the user's kitchen backup. */
export interface AssistantSession {
  recipes: Recipe[];
  attachedRecipes: Recipe[];
  draft: string;
  mode: 'discover' | 'create' | 'library';
  bodyScanIds?: string[];
  inventoryContext?: AssistantInventoryContext;
}
export interface InventoryState {
  products: Product[];
  batches: Batch[];
  tools: Tool[];
  recipes?: Recipe[];
  mealPlan?: MealPlanItem[];
  shoppingList?: ShoppingItem[];
  chatHistory?: ChatMessage[];
  assistantSession?: AssistantSession;
  nutritionTargets?: NutritionTargets;
  recipeNutrition?: (RecipeNutritionMapping & { recipeId: string })[];
  bodyScans?: BodyScan[];
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

export function isAssistantInventoryContext(value: unknown): value is AssistantInventoryContext {
  return (
    isRecord(value) &&
    ['all', 'selected', 'none'].includes(value.mode as string) &&
    Array.isArray(value.productIds) &&
    value.productIds.length <= MAX_ASSISTANT_INVENTORY_PRODUCTS &&
    value.productIds.every(
      (id) =>
        typeof id === 'string' &&
        id.trim().length > 0 &&
        id.length <= MAX_ASSISTANT_PRODUCT_ID_LENGTH,
    ) &&
    new Set(value.productIds).size === value.productIds.length
  );
}

export function isAssistantSession(value: unknown): value is AssistantSession {
  if (!isRecord(value)) return false;
  const recipes = (items: unknown) =>
    Array.isArray(items) &&
    items.length <= 12 &&
    items.every(isRecipe) &&
    new Set(items.map((recipe) => recipe.id)).size === items.length;
  return (
    recipes(value.recipes) &&
    recipes(value.attachedRecipes) &&
    typeof value.draft === 'string' &&
    value.draft.length <= 6000 &&
    (value.inventoryContext === undefined || isAssistantInventoryContext(value.inventoryContext)) &&
    (value.bodyScanIds === undefined ||
      (Array.isArray(value.bodyScanIds) &&
        value.bodyScanIds.length <= 20 &&
        value.bodyScanIds.every(
          (id) => typeof id === 'string' && id.trim().length > 0 && id.length <= 100,
        ) &&
        new Set(value.bodyScanIds).size === value.bodyScanIds.length)) &&
    ['discover', 'create', 'library'].includes(value.mode as string)
  );
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
  if (value.nutritionTargets !== undefined && !isNutritionTargets(value.nutritionTargets))
    return false;
  if (value.assistantSession !== undefined && !isAssistantSession(value.assistantSession))
    return false;
  if (value.bodyScans !== undefined && !isBodyScanCollection(value.bodyScans)) return false;
  if (
    value.recipeNutrition !== undefined &&
    (!Array.isArray(value.recipeNutrition) ||
      value.recipeNutrition.length > 1000 ||
      !value.recipeNutrition.every(
        (item) =>
          isRecord(item) &&
          isNonemptyText(item.recipeId) &&
          isRecipeNutritionMapping({ recipeKey: item.recipeKey, ingredients: item.ingredients }),
      ) ||
      new Set(value.recipeNutrition.map((item) => item.recipeId)).size !==
        value.recipeNutrition.length)
  )
    return false;
  return true;
}
