import type { FormEvent } from 'react';
import { Check, CookingPot, Package, Snowflake, Trash2 } from 'lucide-react';
import type { StorageLocation } from '../domain/types';
import { todayDate } from '../domain/inventory';
import { Modal } from './Modal';
import { Autocomplete } from './Autocomplete';
import { Choice } from './Choice';
import { FOOD_CATALOG } from '../recipes/catalog';

export type ItemDraft = {
  name: string;
  brand: string;
  ingredientName: string;
  quantity: string;
  unit: string;
  location: StorageLocation;
  purchasedOn: string;
  expiresOn: string;
  isStaple: boolean;
  stapleStatus: 'stocked' | 'low' | 'empty';
};

export interface ItemEditorProps {
  editor: { kind: 'add' } | { kind: 'edit'; batchId: string } | null;
  draft: ItemDraft;
  onDraftChange: (draft: ItemDraft) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
  onRemove: (batchId: string) => void;
  busy: boolean;
  error: string;
  suggestions?: readonly string[];
  title?: string;
  description?: string;
  submitLabel?: string;
}

const locationNames: Record<StorageLocation, string> = {
  fridge: 'Fridge',
  freezer: 'Freezer',
  pantry: 'Pantry',
};
const locationIcons = {
  fridge: <Package size={17} />,
  freezer: <Snowflake size={17} />,
  pantry: <CookingPot size={17} />,
};

export function ItemEditor({
  editor,
  draft,
  onDraftChange,
  onClose,
  onSubmit,
  onRemove,
  busy,
  error,
  suggestions = [],
  title,
  description,
  submitLabel,
}: ItemEditorProps) {
  return (
    <Modal
      open={!!editor}
      onClose={() => {
        if (!busy) onClose();
      }}
      title={title ?? (editor?.kind === 'edit' ? 'Edit item' : 'Add an ingredient')}
      description={
        description ??
        (editor?.kind === 'edit'
          ? 'Keep this purchase batch up to date.'
          : 'A few details. Everything else is optional.')
      }
      className="item-editor"
    >
      <form onSubmit={onSubmit} className="item-form">
        <fieldset className="location-picker">
          <legend>Store in</legend>
          <div>
            {(['fridge', 'freezer', 'pantry'] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={draft.location === value}
                className={draft.location === value ? 'active' : ''}
                onClick={() => onDraftChange({ ...draft, location: value })}
              >
                {locationIcons[value]}
                {locationNames[value]}
              </button>
            ))}
          </div>
        </fieldset>
        <label>
          Item name
          <Autocomplete
            label="Item name"
            autoFocus
            value={draft.name}
            onChange={(name) => onDraftChange({ ...draft, name })}
            options={[...suggestions, ...FOOD_CATALOG]}
            placeholder="e.g. Carrots"
            required
          />
        </label>
        <label>
          Brand <span className="optional">optional</span>
          <input
            value={draft.brand}
            onChange={(event) => onDraftChange({ ...draft, brand: event.target.value })}
            placeholder="Any brand is fine"
            maxLength={120}
          />
        </label>

        <details className="item-extra">
          <summary>Recipe matching</summary>
          <label>
            Ingredient name <span className="optional">optional</span>
            <Autocomplete
              label="Ingredient name"
              value={draft.ingredientName}
              onChange={(ingredientName) => onDraftChange({ ...draft, ingredientName })}
              options={FOOD_CATALOG}
              placeholder="e.g. Chicken breast"
            />
            <span className="field-note">
              Use a common ingredient name when the product name is different.
            </span>
          </label>
        </details>
        <div className="form-row">
          <label>
            Quantity
            <input
              type="number"
              min="0"
              step="any"
              value={draft.quantity}
              onChange={(event) => onDraftChange({ ...draft, quantity: event.target.value })}
              placeholder="Unknown"
            />
          </label>
          <label>
            Unit
            <Autocomplete
              label="Unit"
              value={draft.unit}
              onChange={(unit) => onDraftChange({ ...draft, unit })}
              options={['each', 'package', 'g', 'kg', 'oz', 'lb', 'mL', 'L', 'cup', 'tbsp', 'tsp']}
              required
            />
          </label>
        </div>
        <p className="field-note">Not sure how much? Leave quantity blank.</p>
        <div className="form-row">
          <label>
            Purchased
            <input
              type="date"
              required
              value={draft.purchasedOn}
              max={todayDate()}
              onChange={(event) => onDraftChange({ ...draft, purchasedOn: event.target.value })}
            />
          </label>
          <label>
            Expiration <span className="optional">optional</span>
            <input
              type="date"
              value={draft.expiresOn}
              onChange={(event) => onDraftChange({ ...draft, expiresOn: event.target.value })}
            />
          </label>
        </div>
        <label className="switch-label">
          <span>
            <strong>Keep as a staple</strong>
            <small>Assume enough until you mark it low or empty.</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={draft.isStaple}
            onChange={(event) => onDraftChange({ ...draft, isStaple: event.target.checked })}
          />
        </label>
        {draft.isStaple && (
          <label>
            Stock level
            <Choice
              label="Stock level"
              value={draft.stapleStatus}
              onChange={(value) =>
                onDraftChange({ ...draft, stapleStatus: value as ItemDraft['stapleStatus'] })
              }
              options={[
                { value: 'stocked', label: 'Enough on hand' },
                { value: 'low', label: 'Running low' },
                { value: 'empty', label: 'Empty' },
              ]}
            />
          </label>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-footer">
          {editor?.kind === 'edit' && (
            <button
              type="button"
              className="icon-button danger"
              aria-label="Remove this batch"
              onClick={() => onRemove(editor.batchId)}
              disabled={busy}
            >
              <Trash2 size={20} />
            </button>
          )}
          <button type="button" className="button secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            {busy
              ? 'Saving…'
              : (submitLabel ?? (editor?.kind === 'edit' ? 'Save changes' : 'Add to inventory'))}
            <Check size={17} />
          </button>
        </div>
      </form>
    </Modal>
  );
}
