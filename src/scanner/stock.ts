import type { ItemDraft } from '../components/ItemEditor';
import {
  addBatch,
  addProduct,
  convertQuantity,
  updateProduct,
  todayDate,
} from '../domain/inventory';
import { isDateOnly, type InventoryState, type Product } from '../domain/types';
import { canonicalIngredientName } from '../recipes/identity';
import { normalizeBarcode } from './lookup';

export function validateScanDraft(draft: ItemDraft): string | null {
  if (!draft.name.trim()) return 'Give this item a name.';
  if (!draft.unit.trim()) return 'Choose a unit.';
  const quantity = draft.quantity.trim() === '' ? null : Number(draft.quantity);
  if (quantity !== null && (!Number.isFinite(quantity) || quantity < 0))
    return 'Enter a quantity of zero or more, or leave it unknown.';
  if (
    !isDateOnly(draft.purchasedOn) ||
    draft.purchasedOn > todayDate() ||
    (draft.expiresOn && !isDateOnly(draft.expiresOn))
  )
    return 'Enter valid purchase and expiration dates.';
  if (!draft.ingredientName.trim() || !draft.ingredientConfirmed)
    return 'Confirm the ingredient for recipe matching, or choose Use product name.';
  return null;
}

export function findBarcodeProduct(state: InventoryState, barcode: string): Product | undefined {
  return state.products.find(
    (product) => product.barcode && normalizeBarcode(product.barcode) === barcode,
  );
}

/** Add a new purchase, never copy a previous batch's partly consumed quantity. */
export function stockScannedItem(
  state: InventoryState,
  input: {
    draft: ItemDraft;
    barcode: string;
    productId: string;
    batchId: string;
    shoppingId?: string;
    packageQuantity?: Product['packageQuantity'];
    rememberPackageQuantity?: boolean;
  },
): InventoryState {
  const error = validateScanDraft(input.draft);
  if (error) throw new Error(error);
  const { draft, barcode, batchId } = input;
  const existing =
    findBarcodeProduct(state, barcode) ??
    state.products.find(
      (product) =>
        !product.barcode &&
        product.name.toLowerCase() === draft.name.trim().toLowerCase() &&
        (product.brand ?? '').toLowerCase() === draft.brand.trim().toLowerCase(),
    );
  const quantity = draft.quantity.trim() === '' ? null : Number(draft.quantity);
  const packageUnit =
    /^(?:packages?|cans?|bottles?|bags?|packets?|cartons?|boxes|box|each|items?|pieces?|counts?|ct)$/i.test(
      draft.unit.trim(),
    );
  const packageQuantity =
    input.rememberPackageQuantity && quantity !== null && quantity > 0
      ? { quantity, unit: draft.unit.trim() }
      : (existing?.packageQuantity ??
        input.packageQuantity ??
        (packageUnit ? { quantity: 1, unit: draft.unit.trim() } : undefined));
  const product: Product = {
    id: existing?.id ?? input.productId,
    name: draft.name.trim(),
    brand: draft.brand.trim() || undefined,
    barcode,
    ingredientName: draft.ingredientName.trim(),
    isStaple: draft.isStaple,
    ...(packageQuantity ? { packageQuantity } : {}),
  };
  const next = addBatch(
    existing ? updateProduct(state, existing.id, product) : addProduct(state, product),
    {
      id: batchId,
      productId: product.id,
      quantity,
      unit: draft.unit.trim(),
      location: draft.location,
      purchasedOn: draft.purchasedOn,
      expiresOn: draft.expiresOn || null,
      ...(draft.isStaple ? { stapleStatus: draft.stapleStatus } : {}),
    },
  );
  if (
    !input.shoppingId ||
    matchingShoppingItem(state, draft, input.shoppingId) !== input.shoppingId
  )
    return next;
  return {
    ...next,
    shoppingList: next.shoppingList?.map((item) =>
      item.id === input.shoppingId && !item.checked
        ? { ...item, checked: true, addedBatchId: batchId }
        : item,
    ),
  };
}

/** Suggest checking a shopping item only when this new purchase covers its recorded amount. */
export function matchingShoppingItem(
  state: InventoryState,
  draft: ItemDraft,
  requestedId?: string,
): string | undefined {
  if (!draft.ingredientConfirmed) return;
  return state.shoppingList?.find((item) => {
    if (
      item.checked ||
      (requestedId && item.id !== requestedId) ||
      canonicalIngredientName(item.name) !== canonicalIngredientName(draft.ingredientName)
    )
      return false;
    if (item.quantity === null) return true;
    if (!draft.quantity.trim()) return false;
    try {
      return convertQuantity(Number(draft.quantity), draft.unit, item.unit) + 1e-9 >= item.quantity;
    } catch {
      return false;
    }
  })?.id;
}
