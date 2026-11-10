import {
  type Batch,
  type InventoryGroup,
  type InventoryState,
  type Product,
  type StorageLocation,
  type Tool,
  STORAGE_LOCATIONS,
  isDateOnly,
} from './types';

export { isDateOnly } from './types';

export class InventoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InventoryValidationError';
  }
}

function fail(message: string): never {
  throw new InventoryValidationError(message);
}

function requiredText(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} is required.`);
  return value.trim();
}

function assertQuantity(quantity: number | null): void {
  if (quantity !== null && (!Number.isFinite(quantity) || quantity < 0)) {
    fail('Quantity must be zero or greater, or left unknown.');
  }
}

function assertDate(value: string, label: string): void {
  if (!isDateOnly(value)) fail(`${label} must be a valid calendar date.`);
}

export function todayDate(now = new Date()): string {
  return [
    String(now.getFullYear()).padStart(4, '0'),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

/** Products recorded as in stock with dates that have not passed; not a food-safety guarantee. */
export function currentStockProductIds(
  inventory: InventoryState,
  today = todayDate(),
): Set<string> {
  const products = new Map(inventory.products.map((product) => [product.id, product]));
  return new Set(
    inventory.batches
      .filter((batch) => {
        const product = products.get(batch.productId);
        return (
          product &&
          batch.stapleStatus !== 'empty' &&
          (!batch.expiresOn || batch.expiresOn >= today) &&
          (batch.quantity !== 0 ||
            (product.isStaple && (batch.stapleStatus ?? 'stocked') === 'stocked'))
        );
      })
      .map((batch) => batch.productId),
  );
}

function dateValue(value: string): number {
  assertDate(value, 'Date');
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getTime();
}

/** Calendar-day arithmetic independent of local timezone and daylight saving. */
export function daysBetween(start: string, end: string): number {
  return Math.round((dateValue(end) - dateValue(start)) / 86_400_000);
}

export function daysUntil(value: string, from = todayDate()): number {
  return daysBetween(from, value);
}

function normalizeProduct(product: Product): Product {
  requiredText(product.id, 'Product ID');
  const barcode = product.barcode?.trim();
  const brand = product.brand?.trim();
  const ingredientName = product.ingredientName?.trim();
  const packageQuantity = product.packageQuantity;
  if (
    packageQuantity &&
    (!Number.isFinite(packageQuantity.quantity) || packageQuantity.quantity <= 0)
  )
    fail('Original package amount must be greater than zero.');
  return {
    id: product.id,
    name: requiredText(product.name, 'Item name'),
    isStaple: Boolean(product.isStaple),
    ...(barcode ? { barcode } : {}),
    ...(brand ? { brand } : {}),
    ...(ingredientName ? { ingredientName } : {}),
    ...(packageQuantity
      ? {
          packageQuantity: {
            quantity: packageQuantity.quantity,
            unit: requiredText(packageQuantity.unit, 'Original package unit'),
          },
        }
      : {}),
  };
}

function normalizeBatch(batch: Batch): Batch {
  requiredText(batch.id, 'Batch ID');
  requiredText(batch.productId, 'Product ID');
  if (!STORAGE_LOCATIONS.includes(batch.location)) fail('Choose Fridge, Freezer, or Pantry.');
  assertQuantity(batch.quantity);
  assertDate(batch.purchasedOn, 'Purchase date');
  if (batch.expiresOn !== null) assertDate(batch.expiresOn, 'Expiration date');
  if (
    batch.stapleStatus !== undefined &&
    !['stocked', 'low', 'empty'].includes(batch.stapleStatus)
  ) {
    fail('Choose Stocked, Low, or Empty.');
  }
  return {
    id: batch.id,
    productId: batch.productId,
    location: batch.location,
    quantity: batch.quantity,
    unit: batch.unit.trim(),
    purchasedOn: batch.purchasedOn,
    expiresOn: batch.expiresOn,
    ...(batch.stapleStatus === undefined ? {} : { stapleStatus: batch.stapleStatus }),
  };
}

function getBatch(state: InventoryState, id: string): Batch {
  return (
    state.batches.find((batch) => batch.id === id) ??
    fail('This item is no longer in your inventory.')
  );
}

export function addProduct(state: InventoryState, product: Product): InventoryState {
  if (state.products.some((item) => item.id === product.id)) fail('This product already exists.');
  return { ...state, products: [...state.products, normalizeProduct(product)] };
}

export function updateProduct(
  state: InventoryState,
  id: string,
  patch: Partial<Omit<Product, 'id'>>,
): InventoryState {
  const product = state.products.find((item) => item.id === id) ?? fail('Product not found.');
  const next = normalizeProduct({ ...product, ...patch });
  return { ...state, products: state.products.map((item) => (item.id === id ? next : item)) };
}

export function addBatch(state: InventoryState, batch: Batch): InventoryState {
  if (!state.products.some((product) => product.id === batch.productId))
    fail('Choose an existing product first.');
  if (state.batches.some((item) => item.id === batch.id)) fail('This batch already exists.');
  return { ...state, batches: [...state.batches, normalizeBatch(batch)] };
}

export function updateBatch(
  state: InventoryState,
  id: string,
  patch: Partial<Omit<Batch, 'id' | 'productId'>>,
): InventoryState {
  const next = normalizeBatch({ ...getBatch(state, id), ...patch });
  return { ...state, batches: state.batches.map((batch) => (batch.id === id ? next : batch)) };
}

export function moveBatch(
  state: InventoryState,
  id: string,
  location: StorageLocation,
): InventoryState {
  return updateBatch(state, id, { location });
}

export function setBatchRemaining(
  state: InventoryState,
  id: string,
  quantity: number | null,
  unit?: string,
): InventoryState {
  return updateBatch(state, id, { quantity, ...(unit === undefined ? {} : { unit }) });
}

type UnitDefinition = { family: string; factor: number };
const UNITS = new Map<string, UnitDefinition>();
function registerUnit(aliases: string[], family: string, factor: number): void {
  for (const alias of aliases) UNITS.set(alias, { family, factor });
}
registerUnit(['g', 'gram', 'grams'], 'mass', 1);
registerUnit(['kg', 'kilogram', 'kilograms'], 'mass', 1000);
registerUnit(['oz', 'ounce', 'ounces'], 'mass', 28.349523125);
registerUnit(['lb', 'lbs', 'pound', 'pounds'], 'mass', 453.59237);
registerUnit(['ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres'], 'volume', 1);
registerUnit(['l', 'liter', 'liters', 'litre', 'litres'], 'volume', 1000);
registerUnit(['dl', 'deciliter', 'deciliters', 'decilitre', 'decilitres'], 'volume', 100);
registerUnit(['cl', 'centiliter', 'centiliters', 'centilitre', 'centilitres'], 'volume', 10);
registerUnit(['tsp', 'teaspoon', 'teaspoons'], 'volume', 4.92892159375);
registerUnit(['tbsp', 'tablespoon', 'tablespoons'], 'volume', 14.78676478125);
registerUnit(['cup', 'cups'], 'volume', 236.5882365);
registerUnit(['fl oz', 'fluid ounce', 'fluid ounces'], 'volume', 29.5735295625);
// US liquid measures, matching the US cup and fluid ounce above. Pints are left out because
// British recipes use a 20% larger pint under the same name.
registerUnit(['qt', 'quart', 'quarts'], 'volume', 946.352946);
registerUnit(['gal', 'gallon', 'gallons'], 'volume', 3785.411784);
registerUnit(['package', 'packages'], 'package', 1);
registerUnit(['item', 'items', 'piece', 'pieces', 'each', 'count', 'ct'], 'item', 1);
registerUnit(['can', 'cans'], 'can', 1);
registerUnit(['bottle', 'bottles'], 'bottle', 1);
registerUnit(['carton', 'cartons'], 'carton', 1);

function unitKey(unit: string): string {
  return unit.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Never guesses package weights or converts volume to mass. */
export function convertQuantity(amount: number, fromUnit: string, toUnit: string): number {
  if (!Number.isFinite(amount) || amount < 0) fail('Enter a valid amount.');
  const from = unitKey(fromUnit);
  const to = unitKey(toUnit);
  if (from === to) return amount;
  const source = UNITS.get(from);
  const destination = UNITS.get(to);
  if (!source || !destination || source.family !== destination.family) {
    fail(`Use the recorded unit (${toUnit || 'items'}) or enter the amount remaining.`);
  }
  return (amount * source.factor) / destination.factor;
}

export function useBatch(
  state: InventoryState,
  id: string,
  usage: { amount: number; unit: string },
): InventoryState {
  const batch = getBatch(state, id);
  if (!Number.isFinite(usage.amount) || usage.amount <= 0)
    fail('Enter an amount greater than zero.');
  if (batch.quantity === null) fail('Quantity is unknown. Enter the amount remaining instead.');
  const amount = convertQuantity(usage.amount, usage.unit, batch.unit);
  if (amount > batch.quantity + 1e-9)
    fail('That is more than the recorded quantity. Correct the quantity first.');
  const remaining = Math.max(0, Math.round((batch.quantity - amount) * 1e9) / 1e9);
  return updateBatch(state, id, { quantity: remaining });
}

export function removeBatch(state: InventoryState, id: string): InventoryState {
  getBatch(state, id);
  // Retain product metadata so a known barcode can be reused next time.
  return { ...state, batches: state.batches.filter((batch) => batch.id !== id) };
}

export function removeProduct(state: InventoryState, id: string): InventoryState {
  return {
    ...state,
    products: state.products.filter((product) => product.id !== id),
    batches: state.batches.filter((batch) => batch.productId !== id),
  };
}

export function addTool(state: InventoryState, tool: Tool): InventoryState {
  requiredText(tool.id, 'Tool ID');
  if (state.tools.some((item) => item.id === tool.id)) fail('This tool already exists.');
  return {
    ...state,
    tools: [...state.tools, { ...tool, name: requiredText(tool.name, 'Tool name') }],
  };
}

export function updateTool(
  state: InventoryState,
  id: string,
  patch: Partial<Omit<Tool, 'id'>>,
): InventoryState {
  const tool = state.tools.find((item) => item.id === id) ?? fail('Tool not found.');
  const next = { ...tool, ...patch, name: requiredText(patch.name ?? tool.name, 'Tool name') };
  return { ...state, tools: state.tools.map((item) => (item.id === id ? next : item)) };
}

export function removeTool(state: InventoryState, id: string): InventoryState {
  return { ...state, tools: state.tools.filter((tool) => tool.id !== id) };
}

export function compareNames(a: string, b: string): number {
  return a.localeCompare(b, 'en', { sensitivity: 'base' });
}

export function groupInventory(state: InventoryState): InventoryGroup[] {
  const products = new Map(state.products.map((product) => [product.id, product]));
  const groups = new Map<string, InventoryGroup>();
  for (const batch of state.batches) {
    const product = products.get(batch.productId);
    if (!product) continue;
    const id = `${product.id}:${batch.location}`;
    const group: InventoryGroup = groups.get(id) ?? {
      id,
      product,
      location: batch.location,
      batches: [],
      quantity: null,
      unit: '',
      hasUnknownQuantity: false,
      hasMixedUnits: false,
    };
    group.batches.push(batch);
    groups.set(id, group);
  }
  for (const group of groups.values()) {
    group.batches.sort(
      (a, b) => a.purchasedOn.localeCompare(b.purchasedOn) || a.id.localeCompare(b.id),
    );
    group.unit = group.batches[0].unit;
    group.hasUnknownQuantity = group.batches.some((batch) => batch.quantity === null);
    let total = 0;
    for (const batch of group.batches) {
      if (batch.quantity === null) continue;
      try {
        total += convertQuantity(batch.quantity, batch.unit, group.unit);
      } catch {
        group.hasMixedUnits = true;
      }
    }
    group.quantity =
      group.hasUnknownQuantity || group.hasMixedUnits ? null : Math.round(total * 1e9) / 1e9;
  }
  return [...groups.values()].sort(
    (a, b) =>
      STORAGE_LOCATIONS.indexOf(a.location) - STORAGE_LOCATIONS.indexOf(b.location) ||
      compareNames(a.product.name, b.product.name) ||
      a.id.localeCompare(b.id),
  );
}

export function formatQuantity(quantity: number | null, unit: string): string {
  if (quantity === null) return 'Quantity unknown';
  return [
    new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 }).format(quantity),
    unit.trim(),
  ]
    .filter(Boolean)
    .join(' ');
}
