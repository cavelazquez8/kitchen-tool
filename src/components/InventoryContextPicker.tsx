import { useState } from 'react';
import { Check, Search, Star } from 'lucide-react';
import {
  LOCATION_LABELS,
  MAX_ASSISTANT_INVENTORY_PRODUCTS,
  STORAGE_LOCATIONS,
  type AssistantInventoryContext,
  type Batch,
  type InventoryState,
} from '../domain/types';
import { compareNames, currentStockProductIds, formatQuantity } from '../domain/inventory';
import { Modal } from './Modal';
import './inventoryContextPicker.css';

function quantitySummary(batches: Batch[]): string {
  const amounts = new Map<string, { quantity: number; unit: string }>();
  let unknown = false;
  for (const batch of batches) {
    if (batch.quantity === null) {
      unknown = true;
      continue;
    }
    const unit = batch.unit.trim();
    const key = unit.toLowerCase();
    const current = amounts.get(key);
    amounts.set(key, { quantity: (current?.quantity ?? 0) + batch.quantity, unit });
  }
  return [
    ...[...amounts.values()].map(({ quantity, unit }) => formatQuantity(quantity, unit)),
    ...(unknown ? ['Quantity unknown'] : []),
  ].join(' + ');
}

const modes = [
  {
    value: 'all',
    title: 'All inventory',
    description: 'Share everything you have. You can still choose recipes that need groceries.',
  },
  {
    value: 'selected',
    title: 'Choose ingredients',
    description: 'Share only the ingredients you select below.',
  },
  {
    value: 'none',
    title: 'No inventory',
    description: 'Talk about meals without sharing your inventory.',
  },
] as const;

export interface InventoryContextPickerProps {
  inventory: InventoryState;
  value: AssistantInventoryContext;
  onSave: (value: AssistantInventoryContext) => Promise<void>;
  onClose: () => void;
}

export function InventoryContextPicker({
  inventory,
  value,
  onSave,
  onClose,
}: InventoryContextPickerProps) {
  const [mode, setMode] = useState(value.mode);
  const [selected, setSelected] = useState(() => new Set(value.productIds));
  const [preferred, setPreferred] = useState(() => new Set(value.preferredProductIds ?? []));
  const [prioritiesOpen, setPrioritiesOpen] = useState(Boolean(value.preferredProductIds?.length));
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [limitNote, setLimitNote] = useState('');
  const batchesByProduct = new Map<string, Batch[]>();
  for (const batch of inventory.batches) {
    const batches = batchesByProduct.get(batch.productId) ?? [];
    batches.push(batch);
    batchesByProduct.set(batch.productId, batches);
  }
  const products = inventory.products
    .filter((product) => batchesByProduct.has(product.id))
    .sort((a, b) => compareNames(a.name, b.name));
  const currentIds = new Set(products.map((product) => product.id));
  const inStock = currentStockProductIds(inventory);
  const selectedIds = [...selected].filter((id) => currentIds.has(id));
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matches = products.filter((product) =>
    [product.name, product.ingredientName, product.brand]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase()
      .includes(normalizedQuery),
  );
  const selectedCount = selectedIds.length;
  const preferredIds = [...preferred].filter(
    (id) => inStock.has(id) && (mode !== 'selected' || selected.has(id)),
  );

  function toggle(id: string) {
    setSelected((previous) => {
      const next = new Set([...previous].filter((item) => currentIds.has(item)));
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_ASSISTANT_INVENTORY_PRODUCTS) next.add(id);
      return next;
    });
    setPreferred((previous) => {
      const next = new Set(previous);
      next.delete(id);
      return next;
    });
    setLimitNote('');
  }

  function togglePriority(id: string) {
    setPreferred((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_ASSISTANT_INVENTORY_PRODUCTS) next.add(id);
      return next;
    });
  }

  function selectResults() {
    const next = new Set(selectedIds);
    for (const product of matches) {
      if (next.size === MAX_ASSISTANT_INVENTORY_PRODUCTS) break;
      next.add(product.id);
    }
    setSelected(next);
    setLimitNote(
      matches.some((product) => !next.has(product.id))
        ? `You can share up to ${MAX_ASSISTANT_INVENTORY_PRODUCTS.toLocaleString()} ingredients at once.`
        : '',
    );
  }

  async function save() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onSave({
        mode,
        productIds: selectedIds,
        ...(preferredIds.length ? { preferredProductIds: preferredIds } : {}),
      });
      onClose();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Could not save your selection. Your changes are still here; try again.',
      );
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title="Inventory in this chat"
      description="Choose what Gemini can see in your next messages."
      onClose={() => {
        if (!busy) onClose();
      }}
      className="inventory-context-picker"
    >
      <form
        className="inventory-context-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="inventory-context-body">
          <fieldset className="inventory-context-modes" disabled={busy}>
            <legend className="sr-only">Inventory sharing</legend>
            {modes.map((option) => (
              <label
                key={option.value}
                className={
                  mode === option.value ? 'inventory-context-mode active' : 'inventory-context-mode'
                }
              >
                <input
                  type="radio"
                  name="inventory-context-mode"
                  aria-label={option.title}
                  value={option.value}
                  checked={mode === option.value}
                  onChange={() => setMode(option.value)}
                />
                <span>
                  <strong>{option.title}</strong>
                  <small>{option.description}</small>
                </span>
                {mode === option.value && <Check size={18} aria-hidden="true" />}
              </label>
            ))}
          </fieldset>

          {mode === 'all' && (
            <button
              type="button"
              className="text-button inventory-priorities-toggle"
              aria-expanded={prioritiesOpen}
              disabled={busy}
              onClick={() => setPrioritiesOpen((open) => !open)}
            >
              <Star size={16} aria-hidden="true" />
              {prioritiesOpen ? 'Hide ingredient preferences' : 'Prioritize ingredients'}
              {preferredIds.length > 0 ? ` (${preferredIds.length})` : ''}
            </button>
          )}
          {(mode === 'selected' || (mode === 'all' && prioritiesOpen)) && (
            <section className="inventory-context-ingredients" aria-label="Choose ingredients">
              <p
                className="inventory-context-note inventory-priorities-note"
                id="ingredient-priority-help"
              >
                Star ingredients to use first. Gemini can still suggest other recipes.
              </p>
              <label className="inventory-context-search">
                <Search size={18} aria-hidden="true" />
                <input
                  type="search"
                  aria-label="Search your ingredients"
                  placeholder="Search ingredients or brands"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  disabled={busy}
                  enterKeyHint="search"
                />
              </label>
              <div className="inventory-context-selection">
                <span role="status" aria-live="polite">
                  {mode === 'selected' ? `${selectedCount} selected` : 'All inventory shared'}
                  {preferredIds.length > 0 ? ` · ${preferredIds.length} prioritized` : ''}
                </span>
                <div>
                  {mode === 'selected' && (
                    <button
                      type="button"
                      className="text-button"
                      onClick={selectResults}
                      disabled={
                        busy ||
                        matches.length === 0 ||
                        matches.every((product) => selected.has(product.id))
                      }
                    >
                      Select all results
                    </button>
                  )}
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      if (mode === 'selected') setSelected(new Set());
                      setPreferred(new Set());
                      setLimitNote('');
                    }}
                    disabled={
                      busy ||
                      (mode === 'selected' ? selectedCount === 0 : preferredIds.length === 0)
                    }
                  >
                    {mode === 'selected' ? 'Clear' : 'Clear priorities'}
                  </button>
                </div>
              </div>
              {limitNote && (
                <p className="inventory-context-note" role="status">
                  {limitNote}
                </p>
              )}
              {mode === 'selected' && selectedCount === 0 && products.length > 0 && (
                <p className="inventory-context-note">
                  No ingredients selected. Your inventory will not be shared.
                </p>
              )}
              <div className="inventory-context-list" role="group" aria-label="Your ingredients">
                {matches.map((product) => {
                  const batches = batchesByProduct.get(product.id)!;
                  const locations = STORAGE_LOCATIONS.filter((location) =>
                    batches.some((batch) => batch.location === location),
                  ).map((location) => LOCATION_LABELS[location]);
                  return (
                    <div className="inventory-context-item" key={product.id}>
                      <label className="inventory-context-item-selection">
                        {mode === 'selected' && (
                          <input
                            type="checkbox"
                            checked={selected.has(product.id)}
                            disabled={
                              busy ||
                              (!selected.has(product.id) &&
                                selectedCount >= MAX_ASSISTANT_INVENTORY_PRODUCTS)
                            }
                            onChange={() => toggle(product.id)}
                          />
                        )}
                        <span>
                          <strong>{product.name}</strong>
                          {product.brand && (
                            <small className="inventory-context-brand">{product.brand}</small>
                          )}
                          <small>
                            {locations.join(' · ')} <span aria-hidden="true">—</span>{' '}
                            {quantitySummary(batches)}
                          </small>
                          {!inStock.has(product.id) && (
                            <small>Update stock or date to prioritize.</small>
                          )}
                        </span>
                      </label>
                      <button
                        type="button"
                        className="inventory-priority-button"
                        aria-label={`Prioritize ${product.name}`}
                        aria-pressed={preferredIds.includes(product.id)}
                        aria-describedby="ingredient-priority-help"
                        disabled={
                          busy ||
                          !inStock.has(product.id) ||
                          (mode === 'selected' && !selected.has(product.id)) ||
                          (!preferred.has(product.id) &&
                            preferredIds.length >= MAX_ASSISTANT_INVENTORY_PRODUCTS)
                        }
                        onClick={() => togglePriority(product.id)}
                      >
                        <Star
                          size={19}
                          aria-hidden="true"
                          fill={preferredIds.includes(product.id) ? 'currentColor' : 'none'}
                        />
                      </button>
                    </div>
                  );
                })}
                {matches.length === 0 && (
                  <p className="inventory-context-empty">
                    {products.length === 0
                      ? 'Your inventory is empty. Add ingredients in Inventory when you’re ready.'
                      : 'No matching ingredients. Try another name or brand.'}
                  </p>
                )}
              </div>
            </section>
          )}
        </div>

        <div className="inventory-context-footer">
          <p className="inventory-context-note">
            Applies to new messages. Earlier messages may still mention inventory.
          </p>
          {error && (
            <p className="inventory-context-error" role="alert">
              {error}
            </p>
          )}
          <div className="inventory-context-actions">
            <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="button primary" disabled={busy}>
              {busy ? 'Applying…' : 'Apply to chat'}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
