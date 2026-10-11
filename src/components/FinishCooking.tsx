import { useId, useRef, useState, type FormEvent } from 'react';
import { Check } from 'lucide-react';
import type { Batch, InventoryState, Product } from '../domain/types';
import type { InventoryReducer } from '../lib/repository';
import {
  convertQuantity,
  formatQuantity,
  todayDate,
  useBatch as consumeBatch,
} from '../domain/inventory';
import { canonicalIngredientName, matchRecipe } from '../recipes/matching';
import type { Recipe } from '../recipes/types';
import { Modal } from './Modal';

export interface FinishCookingProps {
  recipe: Recipe;
  inventory: InventoryState;
  servings?: number;
  update: (reducer: InventoryReducer) => Promise<void | InventoryState>;
  onClose: () => void;
  onToast: (message: string) => void;
}
interface UsageRow {
  batch: Batch;
  product: Product;
}
interface UsageReview {
  rows: UsageRow[];
  suggestions: Record<string, string>;
  warnings: string[];
}
function rounded(value: number): number {
  return Number.isFinite(value * 1e9) ? Math.round(value * 1e9) / 1e9 : value;
}
function compatibleAmount(amount: number, from: string, to: string): number | null {
  if (!from.trim() || !to.trim()) return null;
  try {
    const converted = convertQuantity(amount, from, to);
    return Number.isFinite(converted) ? converted : null;
  } catch {
    return null;
  }
}
/** Allocate each recorded recipe requirement once, without guessing package contents. */
function buildUsageReview(
  recipe: Recipe,
  inventory: InventoryState,
  servings?: number,
): UsageReview {
  const today = todayDate();
  const names = new Set(
    recipe.ingredients.map((ingredient) => canonicalIngredientName(ingredient.name)),
  );
  const products = new Map(inventory.products.map((product) => [product.id, product]));
  const rows = inventory.batches
    .flatMap((batch) => {
      const product = products.get(batch.productId);
      return product && names.has(canonicalIngredientName(product.ingredientName ?? product.name))
        ? [{ batch, product }]
        : [];
    })
    .sort(
      (a, b) =>
        a.batch.purchasedOn.localeCompare(b.batch.purchasedOn) ||
        a.batch.id.localeCompare(b.batch.id),
    );
  const suggestions: Record<string, string> = {};
  const allocated = new Map<string, number>();
  const match = matchRecipe(recipe, inventory, {
    today,
    ...(servings === undefined ? {} : { servings }),
  });
  const warnings = [...match.warnings];
  for (const demand of match.ingredients) {
    const required = demand.required;
    const name = canonicalIngredientName(demand.ingredient.name);
    if (required === null || !Number.isFinite(required)) {
      warnings.push(
        `${demand.ingredient.name}: check quantities; the recipe amount is not recorded precisely.`,
      );
      continue;
    }
    let remaining = required;
    for (const { batch, product } of rows) {
      if (
        canonicalIngredientName(product.ingredientName ?? product.name) !== name ||
        batch.quantity === null ||
        batch.quantity <= 0 ||
        batch.stapleStatus === 'empty' ||
        (batch.expiresOn && batch.expiresOn < today)
      )
        continue;
      const capacity = Math.max(0, batch.quantity - (allocated.get(batch.id) ?? 0));
      const requiredInBatchUnit = compatibleAmount(remaining, demand.ingredient.unit, batch.unit);
      if (requiredInBatchUnit === null || capacity <= 0) continue;
      const used = Math.min(capacity, requiredInBatchUnit);
      const usedInRecipeUnit = compatibleAmount(used, batch.unit, demand.ingredient.unit);
      if (usedInRecipeUnit === null) continue;
      allocated.set(batch.id, rounded((allocated.get(batch.id) ?? 0) + used));
      remaining = rounded(Math.max(0, remaining - usedInRecipeUnit));
      if (remaining <= 1e-9) break;
    }
    if (remaining > 1e-9)
      warnings.push(
        `${demand.ingredient.name}: check quantities; the full recipe amount cannot be allocated from recorded stock.`,
      );
  }
  for (const [id, amount] of allocated) if (amount > 0) suggestions[id] = String(amount);
  return { rows, suggestions, warnings: [...new Set(warnings)] };
}

export function FinishCooking({
  recipe,
  inventory,
  servings,
  update,
  onClose,
  onToast,
}: FinishCookingProps) {
  // Keep the reviewed units and purchase batches stable while the user edits.
  // The update reducer checks the latest inventory before applying any deduction.
  const [review] = useState(() => buildUsageReview(recipe, inventory, servings));
  const [amounts, setAmounts] = useState<Record<string, string>>(() => ({ ...review.suggestions }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const id = useId();
  const hasAmounts = review.rows.some(({ batch }) => Number(amounts[batch.id]) > 0);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    setError('');
    const uses: { row: UsageRow; amount: number }[] = [];
    for (const row of review.rows) {
      const raw = amounts[row.batch.id]?.trim();
      if (!raw) continue;
      const amount = Number(raw);
      if (!Number.isFinite(amount) || amount < 0) {
        setError('Enter an amount of zero or more, or leave it blank.');
        return;
      }
      if (amount === 0) continue;
      if (row.batch.quantity === null) {
        setError(
          'An unknown starting quantity cannot be deducted. Update that item’s quantity first.',
        );
        return;
      }
      uses.push({ row, amount });
    }
    if (!uses.length) {
      setError('Enter an amount used, or close to leave your inventory unchanged.');
      return;
    }
    pending.current = true;
    setBusy(true);
    try {
      const ingredientNames = new Set(
        recipe.ingredients.map((ingredient) => canonicalIngredientName(ingredient.name)),
      );
      await update((state) =>
        uses.reduce((next, { row, amount }) => {
          const batch = next.batches.find((item) => item.id === row.batch.id);
          const product = next.products.find((item) => item.id === batch?.productId);
          if (!batch || !product)
            throw new Error('An item was removed. Close and review your inventory again.');
          if (
            batch.unit !== row.batch.unit ||
            !ingredientNames.has(canonicalIngredientName(product.ingredientName ?? product.name))
          ) {
            throw new Error(
              'An item’s unit or ingredient changed. Close and review your inventory again.',
            );
          }
          if (batch.quantity === null)
            throw new Error(
              `${product.name}: quantity is now unknown. Update it before deducting.`,
            );
          if (amount > batch.quantity + 1e-9)
            throw new Error(
              `${product.name}: only ${formatQuantity(batch.quantity, batch.unit)} is now recorded. Adjust the amount used.`,
            );
          return consumeBatch(next, batch.id, { amount, unit: row.batch.unit });
        }, state),
      );
      onToast(`Inventory updated for ${recipe.title}.`);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update inventory. Try again.');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      title="Finish cooking"
      description="Review what you used. Only confirmed amounts will leave your inventory."
      onClose={() => {
        if (!pending.current) onClose();
      }}
    >
      <form
        className="item-form cook-usage"
        onSubmit={(event) => {
          void save(event);
        }}
      >
        <div className="cook-usage-summary">
          <p>All ingredients used as written?</p>
          <button
            type="button"
            className="button secondary"
            disabled={busy || !Object.keys(review.suggestions).length}
            onClick={() => {
              setAmounts({ ...review.suggestions });
              setError('');
            }}
          >
            Use suggested amounts
          </button>
        </div>
        <p className="field-note">
          Suggestions use recorded recipe amounts and the oldest eligible purchases. Change an
          amount or leave it blank to keep that batch unchanged.
        </p>
        {!review.rows.length && (
          <p className="field-note">None of these ingredients have matching inventory batches.</p>
        )}
        {review.rows.map(({ batch, product }) => (
          <div className="cook-usage-row" key={batch.id}>
            <div>
              <strong>{product.name}</strong>
              <small>
                Bought {batch.purchasedOn} · {formatQuantity(batch.quantity, batch.unit)}
              </small>
              {batch.expiresOn && batch.expiresOn < todayDate() && (
                <small>Past entered date · no automatic suggestion</small>
              )}
              {batch.quantity === null && (
                <small>Check quantities · unknown amounts stay unchanged</small>
              )}
            </div>
            <label htmlFor={id + '-' + batch.id}>
              Amount used ({batch.unit})
              <input
                id={id + '-' + batch.id}
                aria-label={`Amount used from ${product.name}, bought ${batch.purchasedOn} (${batch.unit})`}
                type="number"
                min="0"
                step="any"
                disabled={busy || batch.quantity === null}
                value={amounts[batch.id] ?? ''}
                placeholder={batch.quantity === null ? 'Check quantity' : 'Not used'}
                onChange={(event) =>
                  setAmounts((current) => ({ ...current, [batch.id]: event.target.value }))
                }
              />
            </label>
          </div>
        ))}
        {review.warnings.length > 0 && (
          <div className="cook-usage-warnings">
            <strong>Check quantities</strong>
            {review.warnings.map((warning) => (
              <p className="field-note" key={warning}>
                {warning}
              </p>
            ))}
          </div>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-footer">
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
            Keep inventory unchanged
          </button>
          <button type="submit" className="button primary" disabled={busy || !hasAmounts}>
            {busy ? 'Updating…' : 'Update inventory'}
            <Check size={17} />
          </button>
        </div>
      </form>
    </Modal>
  );
}
