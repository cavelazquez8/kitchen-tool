import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, Package, Snowflake, CookingPot, Undo2, ScanLine } from 'lucide-react';
import { Scanner } from './Scanner';
import { lookupProduct } from './lookup';
import {
  findBarcodeProduct,
  matchingShoppingItem,
  stockScannedItem,
  validateScanDraft,
} from './stock';
import { ItemEditor, type ItemDraft } from '../components/ItemEditor';
import { Modal } from '../components/Modal';
import { Autocomplete } from '../components/Autocomplete';
import { useFoodCatalog } from '../food/useFoodCatalog';
import { suggestIngredientIdentity, type IngredientIdentitySuggestion } from '../recipes/identity';
import { formatQuantity, removeBatch, todayDate } from '../domain/inventory';
import {
  LOCATION_LABELS,
  STORAGE_LOCATIONS,
  type InventoryState,
  type StorageLocation,
} from '../domain/types';
import type { InventoryReducer } from '../lib/repository';
import './grocerySession.css';

const PREFERENCE_KEY = 'mise:scanner:destination:v1';
type Preferences = { mode: 'each' | 'bulk'; location: StorageLocation; automatic: boolean };
function readPreferences(defaultLocation: StorageLocation): Preferences {
  try {
    const value = JSON.parse(
      localStorage.getItem(PREFERENCE_KEY) ?? 'null',
    ) as Partial<Preferences> | null;
    return {
      mode: value?.mode === 'bulk' ? 'bulk' : 'each',
      location: STORAGE_LOCATIONS.includes(value?.location as StorageLocation)
        ? value!.location!
        : defaultLocation,
      automatic: value?.automatic === true,
    };
  } catch {
    return { mode: 'each', location: defaultLocation, automatic: false };
  }
}
type Review = {
  barcode: string;
  duplicate: boolean;
  unknown: boolean;
  message?: string;
  identity: IngredientIdentitySuggestion;
  locationChosen: boolean;
  packageQuantity?: { quantity: number; unit: string };
};
type Added = {
  id: string;
  name: string;
  location: StorageLocation;
  quantity: number | null;
  unit: string;
  shoppingId?: string;
};
const icons = { fridge: Package, freezer: Snowflake, pantry: CookingPot };

export function GroceryScannerSession({
  inventory,
  update,
  onClose,
  onToast,
  onSavingChange,
  defaultLocation,
  shoppingContext,
}: {
  inventory: InventoryState;
  update: (reducer: InventoryReducer) => Promise<void>;
  onClose: () => void;
  onToast: (message: string) => void;
  onSavingChange: (saving: boolean) => void;
  defaultLocation: StorageLocation;
  shoppingContext: boolean;
}) {
  const [preferences, setPreferences] = useState(() => readPreferences(defaultLocation));
  const [review, setReview] = useState<Review | null>(null);
  const [draft, setDraft] = useState<ItemDraft | null>(null);
  const [details, setDetails] = useState(false);
  const [identityEditing, setIdentityEditing] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [finding, setFinding] = useState(false);
  const [added, setAdded] = useState<Added[]>([]);
  const [checkShopping, setCheckShopping] = useState(false);
  const [rememberPackage, setRememberPackage] = useState(false);
  const latestInventory = useRef(inventory);
  latestInventory.current = inventory;
  const operation = useRef<AbortController | null>(null);
  const pending = useRef<((added: boolean) => void) | null>(null);
  const mounted = useRef(true);
  const savingRef = useRef(false);
  const catalog = useFoodCatalog(
    inventory.products.map((product) => product.name),
    !!review,
  );
  const shoppingId = draft && shoppingContext ? matchingShoppingItem(inventory, draft) : undefined;
  const shoppingItem = inventory.shoppingList?.find((item) => item.id === shoppingId);
  const packageSizeDiffers =
    !!draft?.quantity.trim() &&
    Number(draft.quantity) > 0 &&
    (review?.packageQuantity
      ? Number(draft.quantity) !== review.packageQuantity.quantity ||
        draft.unit.trim() !== review.packageQuantity.unit
      : Number(draft.quantity) !== 1 || draft.unit.trim() !== 'package');
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current?.abort();
      pending.current?.(false);
      pending.current = null;
    };
  }, []);
  function changePreferences(next: Preferences) {
    setPreferences(next);
    try {
      localStorage.setItem(PREFERENCE_KEY, JSON.stringify(next));
    } catch {
      /* Still works in memory. */
    }
  }
  function finishReview(result: boolean) {
    const resolve = pending.current;
    pending.current = null;
    setReview(null);
    setDraft(null);
    setDetails(false);
    setIdentityEditing(false);
    setRememberPackage(false);
    setError('');
    resolve?.(result);
  }
  async function savePurchase(
    value: ItemDraft,
    current: Review,
    selectedShoppingId?: string,
  ): Promise<boolean> {
    if (savingRef.current) return false;
    const validation = validateScanDraft(value);
    if (validation) {
      setError(validation);
      return false;
    }
    if (!current.locationChosen) {
      setError('Choose where this item will go.');
      return false;
    }
    savingRef.current = true;
    setSaving(true);
    onSavingChange(true);
    setError('');
    const batchId = crypto.randomUUID(),
      productId = crypto.randomUUID();
    try {
      await update((state) =>
        stockScannedItem(state, {
          draft: value,
          barcode: current.barcode,
          batchId,
          productId,
          shoppingId: selectedShoppingId,
          packageQuantity: current.packageQuantity,
          rememberPackageQuantity: rememberPackage,
        }),
      );
      if (mounted.current) {
        setAdded((items) => [
          ...items,
          {
            id: batchId,
            name: value.name.trim(),
            location: value.location,
            quantity: value.quantity.trim() === '' ? null : Number(value.quantity),
            unit: value.unit,
            shoppingId: selectedShoppingId,
          },
        ]);
        onToast(`${value.name.trim()} added to ${LOCATION_LABELS[value.location].toLowerCase()}.`);
      }
      return true;
    } catch (failure) {
      if (mounted.current)
        setError(
          failure instanceof Error ? failure.message : 'Could not save this item. Try again.',
        );
      return false;
    } finally {
      savingRef.current = false;
      if (mounted.current) {
        setSaving(false);
        onSavingChange(false);
      }
    }
  }
  async function scan(barcode: string): Promise<boolean> {
    if (operation.current || savingRef.current) return false;
    const controller = new AbortController();
    operation.current = controller;
    setFinding(true);
    try {
      const remembered = findBarcodeProduct(latestInventory.current, barcode);
      // Saved barcode identities and original package sizes work offline.
      const result = remembered ? null : await lookupProduct(barcode, controller.signal);
      if (!mounted.current || controller.signal.aborted) return false;
      const found = result?.status === 'found' ? result.product : undefined;
      const existing =
        remembered ??
        (found &&
          latestInventory.current.products.find(
            (product) =>
              !product.barcode &&
              product.name.toLowerCase() === found.name.toLowerCase() &&
              (product.brand ?? '').toLowerCase() === (found.brand ?? '').toLowerCase(),
          ));
      const identity = existing?.ingredientName
        ? { candidates: [existing.ingredientName], confidence: 'clear' as const }
        : (found?.ingredientIdentity ??
          suggestIngredientIdentity(existing?.name ?? found?.name ?? '', {
            brand: existing?.brand ?? found?.brand,
          }));
      const packageQuantity = existing?.packageQuantity ?? found?.packageQuantity;
      const value: ItemDraft = {
        name: existing?.name ?? found?.name ?? '',
        brand: existing?.brand ?? found?.brand ?? '',
        ingredientName: identity.confidence === 'clear' ? identity.candidates[0] : '',
        ingredientConfirmed: identity.confidence === 'clear',
        quantity: String(packageQuantity?.quantity ?? 1),
        unit: packageQuantity?.unit ?? 'package',
        location: preferences.mode === 'bulk' ? preferences.location : defaultLocation,
        purchasedOn: todayDate(),
        expiresOn: '',
        isStaple: existing?.isStaple ?? false,
        stapleStatus: 'stocked',
      };
      const current: Review = {
        barcode,
        duplicate: !!existing,
        unknown: !existing && !found,
        identity,
        locationChosen: preferences.mode === 'bulk',
        packageQuantity,
        message:
          result && result.status !== 'found'
            ? result.status === 'unavailable'
              ? 'Product lookup is unavailable. Enter a name and Mise will remember this barcode.'
              : 'We couldn’t find this barcode. Enter a name and Mise will remember it next time.'
            : undefined,
      };
      if (
        preferences.mode === 'bulk' &&
        preferences.automatic &&
        !current.duplicate &&
        !current.unknown &&
        value.ingredientConfirmed &&
        !shoppingContext
      ) {
        if (await savePurchase(value, current)) return true;
      }
      setDraft(value);
      setReview(current);
      setError('');
      setCheckShopping(false);
      setIdentityEditing(false);
      setRememberPackage(false);
      return await new Promise<boolean>((resolve) => {
        pending.current = resolve;
      });
    } finally {
      if (operation.current === controller) operation.current = null;
      if (mounted.current) setFinding(false);
    }
  }
  function changeName(name: string) {
    if (!draft || !review) return;
    const identity = suggestIngredientIdentity(name, { brand: draft.brand });
    setDraft({
      ...draft,
      name,
      ingredientName: identity.confidence === 'clear' ? identity.candidates[0] : '',
      ingredientConfirmed: identity.confidence === 'clear',
    });
    setReview({ ...review, identity });
    setCheckShopping(false);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      draft &&
      review &&
      (await savePurchase(draft, review, checkShopping ? shoppingId : undefined))
    )
      finishReview(true);
  }
  async function undo(item: Added) {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    onSavingChange(true);
    try {
      await update((state) => {
        const next = state.batches.some((batch) => batch.id === item.id)
          ? removeBatch(state, item.id)
          : state;
        return {
          ...next,
          shoppingList: next.shoppingList?.map((entry) =>
            entry.addedBatchId === item.id
              ? { ...entry, checked: false, addedBatchId: undefined }
              : entry,
          ),
        };
      });
      setAdded((items) => items.filter((entry) => entry.id !== item.id));
      onToast('Purchase removed.');
    } catch (failure) {
      onToast(failure instanceof Error ? failure.message : 'Could not undo this purchase.');
    } finally {
      savingRef.current = false;
      setSaving(false);
      onSavingChange(false);
    }
  }
  const destinationButtons = (
    value: StorageLocation,
    onChange: (location: StorageLocation) => void,
    chosen = true,
    disabled = saving,
  ) => (
    <div className="grocery-destinations" role="group" aria-label="Store in">
      {STORAGE_LOCATIONS.map((location) => {
        const Icon = icons[location];
        return (
          <button
            key={location}
            type="button"
            disabled={disabled}
            aria-pressed={chosen && value === location}
            className={chosen && value === location ? 'selected' : ''}
            onClick={() => onChange(location)}
          >
            <Icon size={19} />
            {LOCATION_LABELS[location]}
            {chosen && value === location && <Check size={15} />}
          </button>
        );
      })}
    </div>
  );
  return (
    <>
      <Scanner
        onAdd={scan}
        onClose={() => {
          if (!savingRef.current) onClose();
        }}
        successMessage="Added to inventory. Ready for the next package."
        packageCount={added.length}
        controls={
          <div className="grocery-mode-panel">
            <div className="grocery-mode" role="group" aria-label="Scan destination mode">
              <button
                type="button"
                aria-pressed={preferences.mode === 'each'}
                className={preferences.mode === 'each' ? 'selected' : ''}
                disabled={finding || saving}
                onClick={() => changePreferences({ ...preferences, mode: 'each' })}
              >
                Choose after each scan
              </button>
              <button
                type="button"
                aria-pressed={preferences.mode === 'bulk'}
                className={preferences.mode === 'bulk' ? 'selected' : ''}
                disabled={finding || saving}
                onClick={() => changePreferences({ ...preferences, mode: 'bulk' })}
              >
                Bulk scan
              </button>
            </div>
            {preferences.mode === 'bulk' ? (
              <>
                <span className="grocery-field-heading">Send this batch to</span>
                {destinationButtons(
                  preferences.location,
                  (location) => changePreferences({ ...preferences, location }),
                  true,
                  finding || saving,
                )}
                <label className="grocery-auto">
                  <input
                    type="checkbox"
                    disabled={finding || saving}
                    checked={preferences.automatic}
                    onChange={(event) =>
                      changePreferences({ ...preferences, automatic: event.target.checked })
                    }
                  />
                  <span>
                    <strong>Add clear matches automatically</strong>
                    <small>
                      Duplicates, unknown products, and uncertain matches still need review. Dates
                      can be added later.
                    </small>
                  </span>
                </label>
              </>
            ) : (
              <p className="muted">Review each item and tap fridge, freezer, or pantry.</p>
            )}
          </div>
        }
        tray={
          <div className="grocery-recent">
            <div className="tray-title">
              <h3>Added this session</h3>
              <span>{added.length}</span>
            </div>
            {added.length === 0 ? (
              <p className="muted">Your purchases appear here as soon as you add them.</p>
            ) : (
              added
                .slice(-8)
                .reverse()
                .map((item) => (
                  <div key={item.id} className="grocery-recent-row">
                    <span>
                      <strong>{item.name}</strong>
                      <small>
                        {LOCATION_LABELS[item.location]} ·{' '}
                        {formatQuantity(item.quantity, item.unit)}
                      </small>
                    </span>
                    <button
                      type="button"
                      className="text-button"
                      disabled={saving}
                      onClick={() => void undo(item)}
                    >
                      <Undo2 size={16} /> Undo
                    </button>
                  </div>
                ))
            )}
            <button
              type="button"
              className="button secondary full-width"
              disabled={saving}
              onClick={onClose}
            >
              Done scanning
            </button>
          </div>
        }
      />
      <Modal
        open={!!review && !details}
        onClose={() => {
          if (!savingRef.current) finishReview(false);
        }}
        title={
          review?.unknown
            ? 'Product not found'
            : review?.duplicate
              ? 'Add another package?'
              : 'Review scanned item'
        }
        description={
          review?.message ??
          (review?.duplicate
            ? 'You already have this product. Add a new purchase with its own quantity and dates.'
            : 'A quick check, then it’s in your inventory.')
        }
        className="grocery-review-modal"
      >
        {draft && review && (
          <form className="item-form grocery-review" onSubmit={(event) => void submit(event)}>
            <div>
              <span className="grocery-field-heading">Store in</span>
              {destinationButtons(
                draft.location,
                (location) => {
                  setDraft({ ...draft, location });
                  setReview({ ...review, locationChosen: true });
                },
                review.locationChosen,
              )}
            </div>
            <label className="field">
              Item name
              <Autocomplete
                label="Item name"
                autoFocus={review.unknown}
                value={draft.name}
                onChange={changeName}
                options={catalog.names}
                required
                placeholder="What did you buy?"
              />
            </label>
            {draft.brand && <span className="grocery-brand">{draft.brand}</span>}
            <div className="form-row">
              <label className="field">
                Quantity
                <input
                  aria-label="Quantity"
                  inputMode="decimal"
                  value={draft.quantity}
                  placeholder="Unknown"
                  onChange={(event) => {
                    setDraft({ ...draft, quantity: event.target.value });
                    setCheckShopping(false);
                    setRememberPackage(false);
                  }}
                />
              </label>
              <label className="field">
                Unit
                <Autocomplete
                  label="Unit"
                  value={draft.unit}
                  onChange={(unit) => {
                    setDraft({ ...draft, unit });
                    setCheckShopping(false);
                    setRememberPackage(false);
                  }}
                  options={[
                    'each',
                    'package',
                    'g',
                    'kg',
                    'oz',
                    'lb',
                    'mL',
                    'L',
                    'fl oz',
                    'cup',
                    'can',
                    'bottle',
                    'bag',
                  ]}
                />
              </label>
            </div>
            {packageSizeDiffers && review.packageQuantity && (
              <p className="grocery-package-note">
                One package:{' '}
                {formatQuantity(review.packageQuantity.quantity, review.packageQuantity.unit)}.
                Purchase quantity can differ.
              </p>
            )}
            {packageSizeDiffers && (
              <label className="grocery-auto grocery-package-option">
                <input
                  type="checkbox"
                  checked={rememberPackage}
                  onChange={(event) => setRememberPackage(event.target.checked)}
                />
                <span>
                  <strong>Each package contains this amount</strong>
                  <small>Remember it for future scans.</small>
                </span>
              </label>
            )}
            <label className="field">
              Expiration (optional)
              <input
                aria-label="Expiration (optional)"
                type="date"
                value={draft.expiresOn}
                onChange={(event) => setDraft({ ...draft, expiresOn: event.target.value })}
              />
            </label>
            <div className="grocery-identity">
              <span className="grocery-field-heading">Recipe matching</span>
              {draft.ingredientConfirmed && draft.ingredientName ? (
                <p className="grocery-match-confirmed">
                  <Check size={16} /> Matches {draft.ingredientName}
                </p>
              ) : (
                <p className="muted">
                  {review.identity.reason ?? 'Confirm which ingredient this product supplies.'}
                </p>
              )}
              {!draft.ingredientConfirmed && review.identity.candidates.length > 0 && (
                <div className="grocery-candidates">
                  {review.identity.candidates.map((candidate) => (
                    <button
                      key={candidate}
                      type="button"
                      className="button secondary"
                      onClick={() => {
                        setDraft({
                          ...draft,
                          ingredientName: candidate,
                          ingredientConfirmed: true,
                        });
                        setCheckShopping(false);
                      }}
                    >
                      {candidate}
                    </button>
                  ))}
                </div>
              )}
              {draft.ingredientConfirmed && !identityEditing && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setIdentityEditing(true)}
                >
                  Change ingredient match
                </button>
              )}
              {(!draft.ingredientConfirmed || identityEditing) && (
                <>
                  <label className="field">
                    Ingredient name
                    <Autocomplete
                      label="Ingredient name"
                      value={draft.ingredientName}
                      onChange={(ingredientName) => {
                        setIdentityEditing(true);
                        setDraft({
                          ...draft,
                          ingredientName,
                          ingredientConfirmed: !!ingredientName.trim(),
                        });
                        setCheckShopping(false);
                      }}
                      options={catalog.names}
                      placeholder="e.g. Cheddar cheese"
                    />
                  </label>
                  <button
                    type="button"
                    className="text-button"
                    disabled={!draft.name.trim()}
                    onClick={() => {
                      setDraft({
                        ...draft,
                        ingredientName: draft.name.trim(),
                        ingredientConfirmed: true,
                      });
                      setCheckShopping(false);
                    }}
                  >
                    Use product name
                  </button>
                </>
              )}
            </div>
            {shoppingItem && (
              <label className="grocery-auto">
                <input
                  type="checkbox"
                  checked={checkShopping}
                  onChange={(event) => setCheckShopping(event.target.checked)}
                />
                <span>Also check off {shoppingItem.name} on my shopping list</span>
              </label>
            )}
            <button
              type="button"
              className="text-button"
              disabled={saving}
              onClick={() => setDetails(true)}
            >
              Edit details
            </button>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="form-footer">
              <button
                type="button"
                className="button secondary"
                disabled={saving}
                onClick={() => finishReview(false)}
              >
                Skip item
              </button>
              <button type="submit" className="button primary" disabled={saving}>
                <ScanLine size={18} />
                {saving ? 'Adding…' : 'Add & scan next'}
              </button>
            </div>
          </form>
        )}
      </Modal>
      {draft && (
        <ItemEditor
          editor={details ? { kind: 'add' } : null}
          title="Edit scanned item"
          description="Adjust this package, then return to its quick review."
          submitLabel="Return to review"
          draft={draft}
          onDraftChange={(value) => {
            setDraft(value);
            setCheckShopping(false);
            setRememberPackage(false);
          }}
          suggestions={inventory.products.map((product) => product.name)}
          onClose={() => setDetails(false)}
          onSubmit={(event) => {
            event.preventDefault();
            const validation = validateScanDraft(draft);
            if (validation) setError(validation);
            else {
              setReview((current) => current && { ...current, locationChosen: true });
              setError('');
              setDetails(false);
            }
          }}
          onRemove={() => {}}
          busy={saving}
          error={error}
        />
      )}
    </>
  );
}
