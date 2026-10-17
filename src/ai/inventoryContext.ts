import { currentStockProductIds } from '../domain/inventory';
import { generateMarkdown } from '../domain/export';
import {
  MAX_ASSISTANT_INVENTORY_PRODUCTS,
  MAX_ASSISTANT_PRODUCT_ID_LENGTH,
  type AssistantInventoryContext,
  type AssistantSession,
  type InventoryState,
} from '../domain/types';

/** Missing preferences retain the existing full-inventory experience. Invalid ones fail closed. */
export function normalizeAssistantInventoryContext(value?: unknown): AssistantInventoryContext {
  if (value === undefined) return { mode: 'all', productIds: [] };
  if (
    value === null ||
    typeof value !== 'object' ||
    !('mode' in value) ||
    !['all', 'selected', 'none'].includes(value.mode as string)
  )
    return { mode: 'none', productIds: [] };
  const mode = value.mode as AssistantInventoryContext['mode'];
  const ids = 'productIds' in value && Array.isArray(value.productIds) ? value.productIds : [];
  const productIds = [
    ...new Set(
      ids.filter(
        (id): id is string =>
          typeof id === 'string' &&
          id.trim().length > 0 &&
          id.length <= MAX_ASSISTANT_PRODUCT_ID_LENGTH,
      ),
    ),
  ].slice(0, MAX_ASSISTANT_INVENTORY_PRODUCTS);
  const preferred =
    'preferredProductIds' in value && Array.isArray(value.preferredProductIds)
      ? value.preferredProductIds
      : [];
  const preferredProductIds = [
    ...new Set(
      preferred.filter(
        (id): id is string =>
          typeof id === 'string' &&
          id.trim().length > 0 &&
          id.length <= MAX_ASSISTANT_PRODUCT_ID_LENGTH &&
          (mode !== 'selected' || productIds.includes(id)),
      ),
    ),
  ].slice(0, MAX_ASSISTANT_INVENTORY_PRODUCTS);
  return { mode, productIds, ...(preferredProductIds.length ? { preferredProductIds } : {}) };
}

export function assistantInventoryContextForSession(
  session?: AssistantSession,
): AssistantInventoryContext {
  return normalizeAssistantInventoryContext(session?.inventoryContext);
}

/**
 * One boundary for every inventory-dependent assistant operation. A product selection
 * includes its purchases in every location; removed products never widen that selection.
 * Recipes and reviewed profile data remain available to their separate context controls.
 */
export function assistantInventory(
  state: InventoryState,
  context?: AssistantInventoryContext,
): InventoryState {
  const { mode, productIds } = normalizeAssistantInventoryContext(context);
  if (mode === 'all') return state;
  const selectedIds = new Set(mode === 'selected' ? productIds : []);
  const products = state.products.filter((product) => selectedIds.has(product.id));
  const existingIds = new Set(products.map((product) => product.id));
  return {
    ...state,
    products,
    batches: state.batches.filter((batch) => existingIds.has(batch.productId)),
    tools: [],
  };
}

export function assistantInventoryMarkdown(
  state: InventoryState,
  context?: AssistantInventoryContext,
): string {
  const preference = normalizeAssistantInventoryContext(context);
  if (preference.mode === 'none')
    return 'Inventory not shared for this message. Availability has not been checked.';
  const inventory = assistantInventory(state, preference);
  const preferred = new Set(preference.preferredProductIds ?? []);
  const inStock = currentStockProductIds(inventory);
  const names = inventory.products
    .filter((product) => preferred.has(product.id) && inStock.has(product.id))
    .map((product) => product.name);
  const priorities = names.length
    ? `Ingredient preferences (soft, not required): ${names.join('; ')}. Favor recipes using these when they fit the current request. Do not exclude other recipes, force substitutions, or change a publisher recipe just to use them. If no suitable recipe uses them all, suggest a good fit and explain which preferred ingredients it uses and which it leaves out. The user's current request takes precedence.\n\n`
    : '';
  if (preference.mode === 'all')
    return priorities + generateMarkdown(inventory, { includeTools: true });
  const scope =
    'Only selected ingredients are shared below. This is a partial inventory; other food and kitchen tools are not shared. Do not assume unlisted items are missing or unavailable.';
  if (!inventory.products.length)
    return `${scope}\n\nNo ingredients selected for this message. Availability has not been checked.`;
  return `${priorities}${scope}\n\n${generateMarkdown(inventory, { includeTools: false })}`;
}
