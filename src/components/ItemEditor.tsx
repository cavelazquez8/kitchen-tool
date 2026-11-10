import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, CookingPot, Package, Search, Snowflake, Trash2 } from 'lucide-react';
import type { StorageLocation } from '../domain/types';
import { todayDate } from '../domain/inventory';
import { Modal } from './Modal';
import { Autocomplete } from './Autocomplete';
import { Choice } from './Choice';
import { useFoodCatalog } from '../food/useFoodCatalog';
import { findPackagedFoods, type PackagedFood } from '../food/products';
import { suggestIngredientIdentity } from '../recipes/identity';
import { publicUrl } from '../lib/publicUrl';

export type ItemDraft = {
  name: string;
  brand: string;
  ingredientName: string;
  ingredientConfirmed?: boolean;
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
  const catalog = useFoodCatalog(suggestions, !!editor);
  const [productSearch, setProductSearch] = useState(false);
  const [products, setProducts] = useState<PackagedFood[]>([]);
  const [productMessage, setProductMessage] = useState('');
  const [editingIdentity, setEditingIdentity] = useState(false);
  const searchVersion = useRef(0);
  const editorSession = editor ? (editor.kind === 'edit' ? editor.batchId : 'new-item') : 'closed';
  useEffect(() => {
    // A new edit must not receive a late result from a previous item.
    searchVersion.current++;
    setProducts([]);
    setProductMessage('');
    setProductSearch(false);
    setEditingIdentity(false);
  }, [editorSession]);
  const identity = suggestIngredientIdentity(draft.name, { brand: draft.brand });
  const identityConfirmed = !!draft.ingredientName.trim() && draft.ingredientConfirmed === true;
  function confirmIdentity(ingredientName: string) {
    onDraftChange({ ...draft, ingredientName, ingredientConfirmed: true });
    setEditingIdentity(false);
  }
  function changeName(name: string, brand = draft.brand) {
    searchVersion.current++;
    setProducts([]);
    setProductMessage('');
    setEditingIdentity(false);
    const nextIdentity = suggestIngredientIdentity(name, { brand });
    const clear = nextIdentity.confidence === 'clear';
    onDraftChange({
      ...draft,
      name,
      brand,
      ingredientName: clear ? nextIdentity.candidates[0] : '',
      ingredientConfirmed: clear,
    });
  }
  async function searchProducts() {
    const version = ++searchVersion.current;
    setProductSearch(true);
    setProducts([]);
    setProductMessage('');
    try {
      const found = await findPackagedFoods(draft.name);
      if (version !== searchVersion.current) return;
      setProducts(found);
      if (!found.length)
        setProductMessage('No packaged products found. You can still enter this item yourself.');
    } catch (error) {
      if (version === searchVersion.current)
        setProductMessage(
          error instanceof Error ? error.message : 'Product search is unavailable.',
        );
    } finally {
      setProductSearch(false);
    }
  }
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
            onChange={changeName}
            options={catalog.names}
            placeholder="e.g. Carrots"
            required
          />
        </label>
        <div className="food-catalog-note">
          <span>
            {catalog.expanded
              ? `${catalog.names.length.toLocaleString()} food suggestions`
              : catalog.loading
                ? 'Loading more food suggestions…'
                : 'Choose a suggestion or type any item'}
          </span>
          <a
            href={publicUrl('data/food-ingredients.json')}
            download
            title="Food name source and attribution · Open Database License 1.0"
          >
            Open Food Facts
          </a>
        </div>
        <div className="packaged-food-search">
          <button
            className="button secondary"
            type="button"
            disabled={productSearch || busy || draft.name.trim().length < 3}
            onClick={() => void searchProducts()}
          >
            <Search size={16} />
            {productSearch ? 'Finding products…' : 'Find packaged products'}
          </button>
          <span className="field-note">
            Optional search in Open Food Facts. Only the name you enter is sent.
          </span>
          {productMessage && (
            <p className="field-note" role="status">
              {productMessage}
            </p>
          )}
          {!!products.length && (
            <div className="packaged-food-results" aria-label="Packaged product results">
              {products.map((product) => (
                <button
                  key={product.code}
                  type="button"
                  onClick={() => changeName(product.name, product.brand)}
                >
                  <span>
                    <strong>{product.name}</strong>
                    <small>{product.brand || 'Brand not listed'}</small>
                  </span>
                  <Check size={17} />
                </button>
              ))}
            </div>
          )}
        </div>
        <label>
          Brand <span className="optional">optional</span>
          <input
            value={draft.brand}
            onChange={(event) => onDraftChange({ ...draft, brand: event.target.value })}
            placeholder="Any brand is fine"
            maxLength={120}
          />
        </label>

        {!!draft.name.trim() && (
          <div className="food-identity-field" data-confirmed={identityConfirmed}>
            {identityConfirmed && !editingIdentity ? (
              <div className="food-identity-confirmed">
                <Check size={16} aria-hidden="true" />
                <p>
                  Recipes recognize this as <strong>{draft.ingredientName}</strong>
                </p>
                <button
                  type="button"
                  aria-label="Change recipe match"
                  onClick={() => setEditingIdentity(true)}
                >
                  Change
                </button>
              </div>
            ) : (
              <>
                <p className="food-identity-title">Recipe matching</p>
                {draft.name.trim() && !draft.ingredientName && identity.confidence !== 'clear' && (
                  <>
                    <p className="field-note">
                      Choose what this product supplies, or keep its own name.
                    </p>
                    {!!identity.candidates.length && (
                      <div className="food-identity-candidates">
                        {identity.candidates.map((name) => (
                          <button type="button" key={name} onClick={() => confirmIdentity(name)}>
                            {name}
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
                <label>
                  Ingredient name
                  <Autocomplete
                    label="Ingredient name"
                    value={draft.ingredientName}
                    onChange={(ingredientName) => {
                      setEditingIdentity(true);
                      onDraftChange({
                        ...draft,
                        ingredientName,
                        ingredientConfirmed: !!ingredientName.trim(),
                      });
                    }}
                    options={catalog.names}
                    placeholder="e.g. Chicken breast"
                  />
                  <span className="field-note">
                    Recipes compare this name. Your product label stays unchanged.
                  </span>
                </label>
                {!!draft.name.trim() && (
                  <button
                    className="food-identity-own"
                    type="button"
                    onClick={() => confirmIdentity(draft.name.trim())}
                  >
                    Use product name
                  </button>
                )}
                {editingIdentity && identityConfirmed && (
                  <button
                    className="food-identity-done"
                    type="button"
                    onClick={() => setEditingIdentity(false)}
                  >
                    Done
                  </button>
                )}
              </>
            )}
          </div>
        )}
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
