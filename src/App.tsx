import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clipboard,
  Cloud,
  CookingPot,
  ExternalLink,
  Flame,
  Leaf,
  BookOpen,
  MessageCircle,
  ShoppingCart,
  Undo2,
  Package,
  Plus,
  ScanLine,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
  Utensils,
  X,
} from 'lucide-react';
import type {
  Batch,
  InventoryGroup,
  InventoryState,
  Product,
  StorageLocation,
} from './domain/types';
import { isDateOnly, isInventoryState } from './domain/types';
import {
  addBatch,
  addProduct,
  addTool,
  convertQuantity,
  formatQuantity,
  groupInventory,
  removeBatch,
  removeTool,
  setBatchRemaining,
  todayDate,
  updateBatch,
  updateProduct,
  useBatch as consumeBatch,
} from './domain/inventory';
import { generateMarkdown } from './domain/export';
import { getInventoryRepository } from './lib/repository';
import { buildInventoryBackup } from './lib/backup';
import { useInventoryRepository } from './lib/useInventoryRepository';
import { Scanner } from './scanner/Scanner';
import { lookupProduct } from './scanner/lookup';
import { Modal } from './components/Modal';
import { ItemEditor, type ItemDraft } from './components/ItemEditor';
import { InventoryList } from './components/InventoryList';
import { groupExpiry, isSoon } from './components/inventoryPresentation';
import { Autocomplete } from './components/Autocomplete';
import { Choice } from './components/Choice';
import { FOOD_CATALOG, TOOL_CATALOG } from './recipes/catalog';
import { KitchenHub, type HubPage } from './components/KitchenHub';
import { GeminiSettings } from './components/GeminiSettings';

const locationNames: Record<StorageLocation, string> = {
  fridge: 'Fridge',
  freezer: 'Freezer',
  pantry: 'Pantry',
};
type Filter = 'all' | 'soon' | 'undated';
type Page = 'inventory' | 'tools' | HubPage;
type Editor = { kind: 'add' } | { kind: 'edit'; batchId: string };
type ScanEntry = {
  id: string;
  barcode: string;
  name: string;
  brand: string;
  quantity: number | null;
  unit: string;
  purchasedOn: string;
  ingredientName?: string;
  isStaple?: boolean;
  stapleStatus?: ItemDraft['stapleStatus'];
  location: StorageLocation;
  expiresOn: string;
  note?: string;
};

function newDraft(): ItemDraft {
  return {
    name: '',
    ingredientName: '',
    brand: '',
    quantity: '',
    unit: 'each',
    location: 'fridge',
    purchasedOn: todayDate(),
    expiresOn: '',
    isStaple: false,
    stapleStatus: 'stocked',
  };
}
function draftFor(batch: Batch, product: Product): ItemDraft {
  return {
    name: product.name,
    ingredientName: product.ingredientName ?? '',
    brand: product.brand ?? '',
    quantity: batch.quantity === null ? '' : String(batch.quantity),
    unit: batch.unit,
    location: batch.location,
    purchasedOn: batch.purchasedOn,
    expiresOn: batch.expiresOn ?? '',
    isStaple: product.isStaple,
    stapleStatus: batch.stapleStatus ?? 'stocked',
  };
}
function nextId() {
  return crypto.randomUUID();
}
export default function App() {
  const snapshot = useInventoryRepository();
  const repository = getInventoryRepository();
  const inventory = snapshot.state;
  const [page, setPage] = useState<Page>('inventory');
  const [location, setLocation] = useState<'all' | StorageLocation>('all');
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('name');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [draft, setDraft] = useState<ItemDraft>(newDraft);
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportSelected, setExportSelected] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanEntries, setScanEntries] = useState<ScanEntry[]>([]);
  const [scanError, setScanError] = useState('');
  const [scanInProgress, setScanInProgress] = useState(false);
  const scanOperation = useRef<{ session: number; controller: AbortController } | null>(null);
  const scanSaving = useRef(false);
  const [usedBatch, setUsedBatch] = useState<string | null>(null);
  const [usageMode, setUsageMode] = useState<'used' | 'remaining'>('used');
  const [usageAmount, setUsageAmount] = useState('');
  const [deleteBatch, setDeleteBatch] = useState<string | null>(null);
  const [toolName, setToolName] = useState('');
  const [toolToDelete, setToolToDelete] = useState<string | null>(null);
  const [backupToImport, setBackupToImport] = useState<InventoryState | null>(null);
  const [unknownScan, setUnknownScan] = useState<string | null>(null);
  const pendingScan = useRef<{
    barcode: string;
    resolve: (entry: ScanEntry | false) => void;
  } | null>(null);
  const [repeatScan, setRepeatScan] = useState<{ name: string; inTray: boolean } | null>(null);
  const repeatResolver = useRef<((confirmed: boolean) => void) | null>(null);
  const scanSession = useRef(0);
  const undoPending = useRef(false);
  const pendingShoppingId = useRef<string | undefined>(undefined);
  const [undoDeduction, setUndoDeduction] = useState<{
    batchId: string;
    unit: string;
    message: string;
  } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const exportText = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 5500);
    return () => window.clearTimeout(timer);
  }, [toast]);
  useEffect(
    () => () => {
      pendingScan.current?.resolve(false);
      pendingScan.current = null;
      repeatResolver.current?.(false);
      repeatResolver.current = null;
      scanOperation.current?.controller.abort();
      scanOperation.current = null;
      scanSession.current++;
    },
    [],
  );
  const groups = useMemo(() => groupInventory(inventory), [inventory]);
  const visibleGroups = useMemo(
    () =>
      groups
        .filter((group) => {
          if (location !== 'all' && group.location !== location) return false;
          if (filter === 'soon' && !group.batches.some(isSoon)) return false;
          if (filter === 'undated' && !group.batches.some((batch) => !batch.expiresOn))
            return false;
          return `${group.product.name} ${group.product.brand ?? ''}`
            .toLowerCase()
            .includes(search.toLowerCase().trim());
        })
        .sort((a, b) => {
          if (sort === 'expiry')
            return (
              (groupExpiry(a) ?? '9999').localeCompare(groupExpiry(b) ?? '9999') ||
              a.product.name.localeCompare(b.product.name)
            );
          if (sort === 'purchased')
            return b.batches
              .map((x) => x.purchasedOn)
              .sort()
              .at(-1)!
              .localeCompare(
                a.batches
                  .map((x) => x.purchasedOn)
                  .sort()
                  .at(-1)!,
              );
          return a.product.name.localeCompare(b.product.name);
        }),
    [groups, location, filter, search, sort],
  );
  const soonCount = inventory.batches.filter(isSoon).length;
  const undatedCount = inventory.batches.filter((batch) => !batch.expiresOn).length;
  const markdown = useMemo(
    () =>
      generateMarkdown(inventory, {
        ...(exportSelected && selected.length ? { batchIds: selected } : {}),
        includeTools: true,
      }),
    [inventory, exportSelected, selected],
  );
  const currentUsedBatch = inventory.batches.find((batch) => batch.id === usedBatch);
  const currentUsedProduct = inventory.products.find(
    (product) => product.id === currentUsedBatch?.productId,
  );
  const isSaving = busy || snapshot.status === 'saving';

  async function act(action: () => Promise<void>, success?: string) {
    setBusy(true);
    try {
      await action();
      if (success) setToast(success);
      return true;
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Could not save. Please try again.');
      return false;
    } finally {
      setBusy(false);
    }
  }
  function closeEditor() {
    pendingScan.current?.resolve(false);
    pendingScan.current = null;
    pendingShoppingId.current = undefined;
    setUnknownScan(null);
    setEditor(null);
  }
  function decideRepeat(confirmed: boolean) {
    const resolve = repeatResolver.current;
    repeatResolver.current = null;
    setRepeatScan(null);
    resolve?.(confirmed);
  }
  function closeScanner() {
    scanSession.current++;
    scanOperation.current?.controller.abort();
    scanOperation.current = null;
    setScanInProgress(false);
    if (pendingScan.current) closeEditor();
    decideRepeat(false);
    setScannerOpen(false);
  }
  function openAdd() {
    pendingShoppingId.current = undefined;
    setDraft(newDraft());
    setFormError('');
    setEditor({ kind: 'add' });
  }
  function quickAdd(name: string, quantity?: number | null, unit?: string, shoppingId?: string) {
    const previous = inventory.products.find(
      (product) =>
        product.name.toLowerCase() === name.toLowerCase() ||
        product.ingredientName?.toLowerCase() === name.toLowerCase(),
    );
    const batch =
      previous &&
      inventory.batches
        .filter((item) => item.productId === previous.id)
        .sort((a, b) => b.purchasedOn.localeCompare(a.purchasedOn))[0];
    const recordedUnit = unit ?? batch?.unit ?? 'each';
    const countable = [
      'each',
      'piece',
      'pieces',
      'package',
      'can',
      'bottle',
      'bag',
      'packet',
    ].includes(recordedUnit.toLowerCase());
    const recordedQuantity = quantity === undefined ? (countable ? 1 : null) : quantity;
    pendingShoppingId.current = shoppingId;
    setDraft({
      ...newDraft(),
      name: previous?.name ?? name,
      brand: previous?.brand ?? '',
      ingredientName: previous?.ingredientName ?? name,
      quantity: recordedQuantity === null ? '' : String(recordedQuantity),
      unit: recordedUnit,
      location: batch?.location ?? 'fridge',
    });
    setFormError('');
    setEditor({ kind: 'add' });
  }
  function openEdit(batch: Batch, product: Product) {
    setDraft(draftFor(batch, product));
    setFormError('');
    setEditor({ kind: 'edit', batchId: batch.id });
  }
  function toggleSelected(group: InventoryGroup) {
    const ids = group.batches.map((batch) => batch.id);
    setSelected((current) =>
      ids.every((id) => current.includes(id))
        ? current.filter((id) => !ids.includes(id))
        : [...new Set([...current, ...ids])],
    );
  }
  async function saveItem(event: FormEvent) {
    event.preventDefault();
    if (!editor) return;
    const name = draft.name.trim();
    const quantity = draft.quantity.trim() === '' ? null : Number(draft.quantity);
    if (!name) {
      setFormError('Give this item a name.');
      return;
    }
    if (quantity !== null && (!Number.isFinite(quantity) || quantity < 0)) {
      setFormError('Enter a quantity of zero or more, or leave it blank.');
      return;
    }
    if (!draft.unit.trim()) {
      setFormError('Choose a unit.');
      return;
    }
    if (draft.purchasedOn > todayDate()) {
      setFormError('The purchase date cannot be in the future.');
      return;
    }
    if (!isDateOnly(draft.purchasedOn) || (draft.expiresOn && !isDateOnly(draft.expiresOn))) {
      setFormError('Enter valid purchase and expiration dates.');
      return;
    }
    if (pendingScan.current) {
      const { barcode, resolve } = pendingScan.current;
      pendingScan.current = null;
      resolve({
        id: nextId(),
        barcode,
        name,
        brand: draft.brand.trim(),
        quantity,
        unit: draft.unit.trim(),
        purchasedOn: draft.purchasedOn,
        ingredientName: draft.ingredientName.trim() || undefined,
        isStaple: draft.isStaple,
        stapleStatus: draft.isStaple ? draft.stapleStatus : undefined,
        location: draft.location,
        expiresOn: draft.expiresOn,
      });
      setUnknownScan(null);
      setEditor(null);
      return;
    }
    const productId = nextId(),
      batchId = nextId();
    const shoppingId = pendingShoppingId.current;
    setBusy(true);
    setFormError('');
    try {
      await repository.update((state) => {
        if (editor.kind === 'edit') {
          const batch = state.batches.find((item) => item.id === editor.batchId);
          if (!batch) throw new Error('This batch was removed on another device.');
          let next = updateProduct(state, batch.productId, {
            name,
            ingredientName: draft.ingredientName.trim() || undefined,
            brand: draft.brand.trim() || undefined,
            isStaple: draft.isStaple,
          });
          next = updateBatch(next, batch.id, {
            quantity,
            unit: draft.unit.trim(),
            location: draft.location,
            purchasedOn: draft.purchasedOn,
            expiresOn: draft.expiresOn || null,
            stapleStatus: draft.isStaple ? draft.stapleStatus : undefined,
          });
          return next;
        }
        const matching = state.products.find(
          (product) =>
            product.name.toLowerCase() === name.toLowerCase() &&
            (product.brand ?? '').toLowerCase() === draft.brand.trim().toLowerCase(),
        );
        const isStaple = matching?.isStaple || draft.isStaple;
        const product: Product = matching ?? {
          id: productId,
          name,
          ...(draft.ingredientName.trim() ? { ingredientName: draft.ingredientName.trim() } : {}),
          ...(draft.brand.trim() ? { brand: draft.brand.trim() } : {}),
          isStaple,
        };
        const next = matching
          ? updateProduct(state, matching.id, {
              isStaple,
              ...(draft.ingredientName.trim()
                ? { ingredientName: draft.ingredientName.trim() }
                : {}),
            })
          : addProduct(state, product);
        const added = addBatch(next, {
          id: batchId,
          productId: product.id,
          quantity,
          unit: draft.unit.trim(),
          location: draft.location,
          purchasedOn: draft.purchasedOn,
          expiresOn: draft.expiresOn || null,
          ...(isStaple ? { stapleStatus: draft.stapleStatus } : {}),
        });
        return shoppingId
          ? {
              ...added,
              shoppingList: added.shoppingList?.map((item) =>
                item.id === shoppingId ? { ...item, checked: true, addedBatchId: batchId } : item,
              ),
            }
          : added;
      });
      pendingShoppingId.current = undefined;
      setEditor(null);
      setToast(
        editor.kind === 'add'
          ? `${name} added to ${locationNames[draft.location].toLowerCase()}.`
          : `${name} updated.`,
      );
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Could not save. Try again.');
    } finally {
      setBusy(false);
    }
  }
  async function copyInventory(useSelection = false) {
    setExportSelected(useSelection);
    const text = generateMarkdown(inventory, {
      ...(useSelection && selected.length ? { batchIds: selected } : {}),
      includeTools: true,
    });
    try {
      await navigator.clipboard.writeText(text);
      setToast('Inventory copied. Paste it into your Gemini conversation.');
    } catch {
      setExportOpen(true);
      setToast('Select and copy the inventory below.');
    }
  }
  function download(text: string, filename: string, type: string) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function readBackup(file?: File) {
    if (!file) return;
    try {
      if (file.size > 10_000_000) throw new Error('This backup is too large.');
      const parsed: unknown = JSON.parse(await file.text());
      const state =
        typeof parsed === 'object' && parsed !== null && 'inventory' in parsed
          ? parsed.inventory
          : parsed;
      if (!isInventoryState(state))
        throw new Error('That file is not a valid Mise inventory backup.');
      setBackupToImport(buildInventoryBackup(state).inventory);
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Could not read this backup.');
    }
    if (fileInput.current) fileInput.current.value = '';
  }
  async function handleScanBarcode(code: string): Promise<boolean> {
    if (scanOperation.current || scanSaving.current) return false;
    const operation = { session: scanSession.current, controller: new AbortController() };
    scanOperation.current = operation;
    setScanInProgress(true);
    try {
      return await scanBarcode(code, operation.controller.signal);
    } finally {
      if (scanOperation.current === operation) {
        scanOperation.current = null;
        setScanInProgress(false);
      }
    }
  }
  async function scanBarcode(code: string, signal: AbortSignal): Promise<boolean> {
    setScanError('');
    const session = scanSession.current;
    const existing = inventory.products.find((product) => product.barcode === code);
    const inTray = scanEntries.find((entry) => entry.barcode === code);
    if (existing || inTray) {
      const confirmed = await new Promise<boolean>((resolve) => {
        repeatResolver.current = resolve;
        setRepeatScan({ name: inTray?.name ?? existing!.name, inTray: !!inTray });
      });
      if (!confirmed || session !== scanSession.current) return false;
      if (
        inTray &&
        inTray.quantity !== null &&
        ['each', 'package'].includes(inTray.unit.toLowerCase())
      ) {
        setScanEntries((entries) =>
          entries.map((entry) =>
            entry.id === inTray.id
              ? { ...entry, quantity: entry.quantity === null ? null : entry.quantity + 1 }
              : entry,
          ),
        );
        return true;
      }
    }
    const result = existing || inTray ? null : await lookupProduct(code, signal);
    if (session !== scanSession.current) return false;
    if (result && result.status !== 'found') {
      const entry = await new Promise<ScanEntry | false>((resolve) => {
        pendingScan.current = { barcode: code, resolve };
        setUnknownScan(
          result.status === 'unavailable'
            ? 'Product lookup is unavailable. Enter this item’s details and Mise will remember its barcode.'
            : 'We couldn’t find this barcode. Enter this item’s details and Mise will remember it next time.',
        );
        setDraft({
          ...newDraft(),
          quantity: '1',
          unit: 'package',
          location: location === 'all' ? 'fridge' : location,
        });
        setFormError('');
        setEditor({ kind: 'add' });
      });
      if (!entry || session !== scanSession.current) return false;
      setScanEntries((entries) => [...entries, entry]);
      return true;
    }
    const previousBatch =
      existing &&
      inventory.batches
        .filter((batch) => batch.productId === existing.id)
        .sort((a, b) => b.purchasedOn.localeCompare(a.purchasedOn))[0];
    setScanEntries((entries) => [
      ...entries,
      {
        id: nextId(),
        barcode: code,
        name:
          existing?.name ?? inTray?.name ?? (result?.status === 'found' ? result.product.name : ''),
        brand:
          existing?.brand ??
          inTray?.brand ??
          (result?.status === 'found' ? (result.product.brand ?? '') : ''),
        ingredientName: existing?.ingredientName ?? inTray?.ingredientName,
        quantity: 1,
        unit: 'package',
        purchasedOn: todayDate(),
        location:
          inTray?.location ?? previousBatch?.location ?? (location === 'all' ? 'fridge' : location),
        expiresOn: '',
      },
    ]);
    return true;
  }
  function updateScan(id: string, patch: Partial<ScanEntry>) {
    setScanEntries((entries) =>
      entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
    );
  }
  async function saveScan() {
    if (!scanEntries.length || scanSaving.current) return;
    if (scanOperation.current) {
      setScanError('Finish reviewing the current item before adding your groceries.');
      return;
    }
    if (
      scanEntries.some(
        (entry) =>
          !entry.name.trim() ||
          !entry.unit.trim() ||
          (entry.quantity !== null && (!Number.isFinite(entry.quantity) || entry.quantity < 0)) ||
          !isDateOnly(entry.purchasedOn) ||
          entry.purchasedOn > todayDate() ||
          !!(entry.expiresOn && !isDateOnly(entry.expiresOn)),
      )
    ) {
      setScanError(
        'Give each item a name, unit, valid dates, and a quantity of zero or more—or leave it unknown.',
      );
      return;
    }
    scanSaving.current = true;
    const entries = scanEntries.map((entry) => ({
      ...entry,
      productId: nextId(),
      batchId: nextId(),
    }));
    setBusy(true);
    try {
      await repository.update((state) =>
        entries.reduce((next, entry) => {
          const existing =
            next.products.find((product) => product.barcode === entry.barcode) ??
            next.products.find(
              (product) =>
                (!product.barcode || product.barcode === entry.barcode) &&
                product.name.toLowerCase() === entry.name.trim().toLowerCase() &&
                (product.brand ?? '').toLowerCase() === entry.brand.trim().toLowerCase(),
            );
          const product: Product = {
            id: existing?.id ?? entry.productId,
            name: entry.name.trim(),
            ...(entry.ingredientName?.trim() || existing?.ingredientName
              ? { ingredientName: entry.ingredientName?.trim() || existing?.ingredientName }
              : {}),
            ...(entry.brand.trim() ? { brand: entry.brand.trim() } : {}),
            barcode: entry.barcode,
            isStaple: existing?.isStaple || entry.isStaple || false,
          };
          const updated = existing
            ? updateProduct(next, existing.id, {
                name: product.name,
                brand: product.brand,
                barcode: entry.barcode,
                ingredientName: product.ingredientName,
                isStaple: product.isStaple,
              })
            : addProduct(next, product);
          return addBatch(updated, {
            id: entry.batchId,
            productId: product.id,
            location: entry.location,
            quantity: entry.quantity,
            unit: entry.unit,
            purchasedOn: entry.purchasedOn,
            expiresOn: entry.expiresOn || null,
            ...(product.isStaple
              ? { stapleStatus: entry.stapleStatus ?? ('stocked' as const) }
              : {}),
          });
        }, state),
      );
      closeScanner();
      setScanEntries([]);
      setToast('Groceries added. You’re all stocked up.');
    } catch (error) {
      setScanError(error instanceof Error ? error.message : 'Could not add groceries. Try again.');
    } finally {
      scanSaving.current = false;
      setBusy(false);
    }
  }
  async function saveUsage(event: FormEvent) {
    event.preventDefault();
    if (
      !currentUsedBatch ||
      !Number.isFinite(Number(usageAmount)) ||
      Number(usageAmount) < 0 ||
      !usageAmount.trim()
    ) {
      setFormError('Enter a quantity of zero or more.');
      return;
    }
    setBusy(true);
    setFormError('');
    try {
      const batchId = currentUsedBatch.id,
        amount = Number(usageAmount),
        unit = currentUsedBatch.unit;
      await repository.update((state) =>
        usageMode === 'used'
          ? consumeBatch(state, batchId, { amount, unit })
          : setBatchRemaining(state, batchId, amount, unit),
      );
      setUsedBatch(null);
      setToast('Quantity updated.');
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Could not update quantity.');
    } finally {
      setBusy(false);
    }
  }
  async function deductOne(batch: Batch) {
    const name =
      inventory.products.find((product) => product.id === batch.productId)?.name ?? 'item';
    const message = `Used one ${name}.`;
    const saved = await act(
      () =>
        repository.update((state) =>
          consumeBatch(state, batch.id, { amount: 1, unit: batch.unit }),
        ),
      message,
    );
    if (saved) setUndoDeduction({ batchId: batch.id, unit: batch.unit, message });
  }
  async function undoLastDeduction() {
    if (!undoDeduction || undoPending.current) return;
    undoPending.current = true;
    const { batchId, unit } = undoDeduction;
    const saved = await act(
      () =>
        repository.update((state) => {
          const batch = state.batches.find((item) => item.id === batchId);
          if (!batch || batch.quantity === null)
            throw new Error('This quantity changed. Please edit the item to correct it.');
          return setBatchRemaining(
            state,
            batchId,
            batch.quantity + convertQuantity(1, unit, batch.unit),
          );
        }),
      'Quantity restored.',
    );
    if (saved) setUndoDeduction(null);
    undoPending.current = false;
  }
  const scanPackageCount = scanEntries.reduce(
    (sum, entry) =>
      sum +
      (entry.quantity !== null && ['each', 'package'].includes(entry.unit.toLowerCase())
        ? entry.quantity
        : 1),
    0,
  );
  const scanTray = (
    <div className="scan-tray">
      <div className="tray-title">
        <h3>Quick review</h3>
        <span>
          {scanEntries.length} {scanEntries.length === 1 ? 'item' : 'items'}
        </span>
      </div>
      {!scanEntries.length && (
        <div className="tray-empty">
          <Package size={28} />
          <p>Your scanned groceries will appear here.</p>
          <span>Check names, storage, and dates before adding.</span>
        </div>
      )}
      {scanEntries.map((entry) => (
        <div className="scan-entry" key={entry.id}>
          <div className="scan-entry-top">
            <label>
              Item name
              <Autocomplete
                label="Item name"
                value={entry.name}
                placeholder="What did you scan?"
                options={[...inventory.products.map((product) => product.name), ...FOOD_CATALOG]}
                onChange={(name) => updateScan(entry.id, { name })}
              />
            </label>
            <button
              className="icon-button"
              aria-label={`Remove ${entry.name || 'scanned item'}`}
              onClick={() =>
                setScanEntries((items) => items.filter((item) => item.id !== entry.id))
              }
            >
              <X size={18} />
            </button>
          </div>
          {entry.note && <p className="field-note">{entry.note}</p>}
          <label>
            Store in
            <Choice
              label={`Store ${entry.name || 'scanned item'} in`}
              value={entry.location}
              onChange={(value) => updateScan(entry.id, { location: value as StorageLocation })}
              options={Object.entries(locationNames).map(([value, label]) => ({ value, label }))}
            />
          </label>
          <div className="form-row">
            <label>
              Quantity
              <input
                type="number"
                min="0"
                step="any"
                value={entry.quantity ?? ''}
                placeholder="Unknown"
                onChange={(event) =>
                  updateScan(entry.id, {
                    quantity: event.target.value === '' ? null : Number(event.target.value),
                  })
                }
              />
            </label>
            <label>
              Unit
              <Autocomplete
                label="Unit"
                value={entry.unit}
                options={[
                  'package',
                  'each',
                  'g',
                  'kg',
                  'oz',
                  'lb',
                  'mL',
                  'L',
                  'cup',
                  'tbsp',
                  'tsp',
                ]}
                onChange={(unit) => updateScan(entry.id, { unit })}
              />
            </label>
          </div>
          <label>
            Purchased
            <input
              type="date"
              value={entry.purchasedOn}
              max={todayDate()}
              onChange={(event) => updateScan(entry.id, { purchasedOn: event.target.value })}
            />
          </label>
          <label>
            Expiration <span className="optional">optional</span>
            <input
              type="date"
              value={entry.expiresOn}
              onChange={(event) => updateScan(entry.id, { expiresOn: event.target.value })}
            />
          </label>
        </div>
      ))}
      {scanError && (
        <p className="form-error" role="alert">
          {scanError}
        </p>
      )}
      <button
        className="button primary full-width"
        disabled={!scanEntries.length || isSaving || scanInProgress}
        onClick={() => {
          void saveScan();
        }}
      >
        <CheckCheck size={18} />
        {isSaving ? 'Saving…' : 'Add to inventory'}
      </button>
    </div>
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(event) => {
            event.preventDefault();
            setPage('inventory');
          }}
          aria-label="Mise home"
        >
          <span className="brand-mark">
            m<span>·</span>
          </span>
          <div>
            mise<span>YOUR KITCHEN, IN ORDER</span>
          </div>
        </a>
        <div className="nav-label">YOUR SPACE</div>
        <nav className="main-nav" aria-label="Main navigation">
          <button
            aria-label="Inventory"
            title="Inventory"
            className={page === 'inventory' ? 'active' : ''}
            onClick={() => setPage('inventory')}
          >
            <Package size={20} />
            <span>Inventory</span>
            {inventory.products.length > 0 && (
              <small>
                {
                  inventory.products.filter((p) =>
                    inventory.batches.some((b) => b.productId === p.id),
                  ).length
                }
              </small>
            )}
          </button>
          <button
            aria-label="Kitchen tools"
            title="Kitchen tools"
            className={page === 'tools' ? 'active' : ''}
            onClick={() => setPage('tools')}
          >
            <Utensils size={20} />
            <span>Kitchen tools</span>
          </button>
          {(
            [
              { value: 'recipes', label: 'Recipes', icon: BookOpen },
              { value: 'shopping', label: 'Shopping list', icon: ShoppingCart },
              { value: 'assistant', label: 'Gemini', icon: Sparkles },
            ] as const
          ).map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              aria-label={label}
              title={label}
              className={page === value ? 'active' : ''}
              onClick={() => setPage(value)}
            >
              <Icon size={20} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <Leaf size={23} />
          <p>
            A little less waste.
            <br />A little more possibility.
          </p>
        </div>
        <div className="sidebar-bottom">
          <button
            aria-label="Settings and backup"
            title="Settings and backup"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings size={18} />
            <span>Settings & backup</span>
          </button>
          <div className="version">
            MISE <span>v0.1</span>
          </div>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <div className="mobile-brand">
            mise<span>·</span>
          </div>
          <span className="topbar-context">
            {page === 'inventory'
              ? 'The everyday, made easier'
              : page === 'tools'
                ? 'Everything you cook with'
                : page === 'recipes'
                  ? 'Make something good'
                  : page === 'shopping'
                    ? 'Bring home what you need'
                    : 'A little help in your kitchen'}
          </span>
          <button className={`sync-pill ${snapshot.mode}`} onClick={() => setSettingsOpen(true)}>
            <span className="status-dot" />
            {snapshot.status === 'saving'
              ? 'Saving…'
              : snapshot.status === 'loading'
                ? 'Connecting…'
                : snapshot.status === 'error'
                  ? 'Saving unavailable'
                  : snapshot.mode === 'cloud'
                    ? 'Synced kitchen'
                    : 'Local only'}
            <ChevronDown size={14} />
          </button>
          <button
            className="icon-button mobile-settings"
            aria-label="Settings and backup"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings size={20} />
          </button>
        </header>
        <div className="page-content">
          {snapshot.error && (
            <div className="error-banner" role="alert">
              <CircleHelp size={19} />
              <span>{snapshot.error}</span>
              <button onClick={() => setSettingsOpen(true)}>Settings</button>
            </div>
          )}
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                <span />
                YOUR EVERYDAY, ORGANIZED
              </div>
              <h1>
                {page === 'inventory'
                  ? 'Your kitchen inventory'
                  : page === 'tools'
                    ? 'Your kitchen tools'
                    : page === 'recipes'
                      ? 'Recipes for your kitchen'
                      : page === 'shopping'
                        ? 'Your shopping list'
                        : 'Cook with Gemini'}
              </h1>
              <p>
                {page === 'inventory'
                  ? 'Know what’s here. Make something good.'
                  : page === 'tools'
                    ? 'The right tools make all the difference.'
                    : page === 'recipes'
                      ? 'Find a favorite. See what you can make.'
                      : page === 'shopping'
                        ? 'Plan meals. Buy just what’s missing.'
                        : 'Your ingredients, your recipes, your conversation.'}
              </p>
            </div>
            {page === 'inventory' && (
              <div className="heading-actions">
                <button
                  className="button secondary"
                  onClick={() => {
                    setScanError('');
                    setScannerOpen(true);
                  }}
                >
                  <ScanLine size={19} />
                  <span>Scan groceries</span>
                </button>
                <button className="button primary" onClick={openAdd}>
                  <Plus size={19} />
                  <span>Add item</span>
                </button>
              </div>
            )}
          </div>
          {page === 'recipes' || page === 'shopping' || page === 'assistant' ? (
            <KitchenHub
              page={page}
              inventory={inventory}
              selectedBatchIds={selected}
              update={(reducer) => repository.update(reducer)}
              onToast={setToast}
              onQuickAdd={quickAdd}
              onScan={() => setScannerOpen(true)}
              onConfigure={() => setSettingsOpen(true)}
              onNavigate={setPage}
            />
          ) : page === 'inventory' ? (
            <>
              <div className="overview-grid">
                <button
                  className={`overview-card ${filter === 'all' ? 'chosen' : ''}`}
                  onClick={() => setFilter('all')}
                >
                  <div className="overview-icon green">
                    <Package size={21} />
                  </div>
                  <div>
                    <span>In your kitchen</span>
                    <strong>
                      {groups.length}
                      <small>{groups.length === 1 ? 'item' : 'items'}</small>
                    </strong>
                  </div>
                  <ChevronRight size={16} />
                </button>
                <button
                  className={`overview-card ${filter === 'soon' ? 'chosen' : ''}`}
                  onClick={() => {
                    setFilter((current) => (current === 'soon' ? 'all' : 'soon'));
                    setSort('expiry');
                  }}
                >
                  <div className="overview-icon amber">
                    <Flame size={21} />
                  </div>
                  <div>
                    <span>Check soon</span>
                    <strong>
                      {soonCount}
                      <small>{soonCount === 1 ? 'batch' : 'batches'}</small>
                    </strong>
                  </div>
                  <ChevronRight size={16} />
                </button>
                <button
                  className={`overview-card ${filter === 'undated' ? 'chosen' : ''}`}
                  onClick={() =>
                    setFilter((current) => (current === 'undated' ? 'all' : 'undated'))
                  }
                >
                  <div className="overview-icon neutral">
                    <CircleHelp size={21} />
                  </div>
                  <div>
                    <span>Missing a date</span>
                    <strong>
                      {undatedCount}
                      <small>{undatedCount === 1 ? 'batch' : 'batches'}</small>
                    </strong>
                  </div>
                  <ChevronRight size={16} />
                </button>
              </div>
              <div className="inventory-panel">
                <div className="panel-controls">
                  <div className="storage-tabs" role="group" aria-label="Storage location">
                    {(['all', 'fridge', 'freezer', 'pantry'] as const).map((value) => (
                      <button
                        key={value}
                        className={location === value ? 'active' : ''}
                        onClick={() => setLocation(value)}
                      >
                        {value === 'all' ? 'Everything' : locationNames[value]}
                        <span>
                          {value === 'all'
                            ? groups.length
                            : groups.filter((group) => group.location === value).length}
                        </span>
                      </button>
                    ))}
                  </div>
                  <div className="search-sort">
                    <label className="search-field">
                      <Search size={17} />
                      <input
                        aria-label="Search inventory"
                        placeholder="Find an ingredient…"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                      />
                    </label>
                    <Choice
                      label="Sort inventory"
                      value={sort}
                      onChange={setSort}
                      options={[
                        { value: 'name', label: 'Name A–Z' },
                        { value: 'expiry', label: 'Expiration date' },
                        { value: 'purchased', label: 'Recently bought' },
                      ]}
                    />
                  </div>
                </div>
                {selected.length > 0 && (
                  <div className="selection-bar">
                    <span>
                      <Check size={16} />
                      {selected.length} {selected.length === 1 ? 'batch' : 'batches'} selected
                    </span>
                    <button
                      onClick={() => {
                        void copyInventory(true);
                      }}
                    >
                      <Clipboard size={16} />
                      Copy selected
                    </button>
                    <button
                      className="icon-button"
                      aria-label="Clear selection"
                      onClick={() => setSelected([])}
                    >
                      <X size={17} />
                    </button>
                  </div>
                )}
                {filter !== 'all' && (
                  <div className="filter-banner">
                    <span>
                      {filter === 'soon'
                        ? 'Dated within 3 days or past the entered date. Check the label and condition.'
                        : 'These batches have no expiration date. Purchase age is shown below.'}
                    </span>
                    <button onClick={() => setFilter('all')}>Show all</button>
                  </div>
                )}
                {snapshot.status === 'loading' && (
                  <div className="loading-state">Opening your kitchen…</div>
                )}
                {!inventory.batches.length && snapshot.status !== 'loading' ? (
                  <div className="empty-state">
                    <div className="empty-art">
                      <div className="empty-orbit" />
                      <div className="empty-basket">
                        <CookingPot size={52} strokeWidth={1.25} />
                        <span>
                          <Leaf size={21} />
                        </span>
                      </div>
                      <span className="art-dot one" />
                      <span className="art-dot two" />
                    </div>
                    <div className="eyebrow">A FRESH START</div>
                    <h2>A calmer kitchen starts here.</h2>
                    <p>
                      Add a few ingredients you already have.
                      <br />
                      We’ll keep everything in one easy place.
                    </p>
                    <button className="button primary" onClick={openAdd}>
                      <Plus size={18} />
                      Add your first item
                    </button>
                    <button className="text-button" onClick={() => setScannerOpen(true)}>
                      <ScanLine size={16} />
                      Or scan your groceries
                      <ArrowRight size={15} />
                    </button>
                  </div>
                ) : (
                  <>
                    <InventoryList
                      groups={visibleGroups}
                      expanded={expanded}
                      selected={selected}
                      onToggleGroup={(id) => setExpanded((current) => (current === id ? null : id))}
                      onToggleSelected={toggleSelected}
                      onEdit={openEdit}
                      onDeduct={(batch) => {
                        void deductOne(batch);
                      }}
                      onUse={(batch) => {
                        setUsedBatch(batch.id);
                        setUsageMode(batch.quantity === null ? 'remaining' : 'used');
                        setUsageAmount('');
                        setFormError('');
                      }}
                      onClearFilters={() => {
                        setSearch('');
                        setLocation('all');
                        setFilter('all');
                      }}
                    />
                  </>
                )}
                <div className="panel-footer">
                  <ShieldCheck size={15} />
                  <span>
                    {snapshot.mode === 'cloud'
                      ? 'Saved to your personal kitchen'
                      : 'Saved in this browser'}
                    {snapshot.status === 'saving' ? ' · Saving…' : ''}
                  </span>
                  <span>
                    {inventory.batches.length} purchase{' '}
                    {inventory.batches.length === 1 ? 'batch' : 'batches'}
                  </span>
                </div>
              </div>
              <div className="gemini-card">
                <div className="gemini-icon">
                  <Sparkles size={24} strokeWidth={1.5} />
                </div>
                <div className="gemini-copy">
                  <h2>Your ingredients. A little inspiration.</h2>
                  <p>Ask Gemini what’s for dinner, or copy your inventory to any AI.</p>
                </div>
                <div className="gemini-actions">
                  <button className="button primary" onClick={() => setPage('assistant')}>
                    <MessageCircle size={17} /> Ask Gemini
                  </button>
                  <button
                    className="button mint-outline"
                    onClick={() => {
                      void copyInventory(false);
                    }}
                  >
                    <Clipboard size={17} />
                    Copy for Gemini
                  </button>
                  <a
                    className="icon-button"
                    href="https://gemini.google.com/app"
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Open Gemini"
                  >
                    <ExternalLink size={19} />
                  </a>
                  <button
                    className="icon-button"
                    aria-label="Preview inventory export"
                    onClick={() => {
                      setExportSelected(false);
                      setExportOpen(true);
                    }}
                  >
                    <ChevronRight size={20} />
                  </button>
                </div>
              </div>
              <p className="footnote">A little less planning. A little more cooking.</p>
            </>
          ) : (
            <div className="tools-panel">
              <form
                className="tool-add"
                onSubmit={(event) => {
                  event.preventDefault();
                  const name = toolName.trim();
                  if (!name) return;
                  const id = nextId();
                  void act(
                    () => repository.update((state) => addTool(state, { id, name })),
                    `${name} added.`,
                  ).then((saved) => {
                    if (saved) setToolName('');
                  });
                }}
              >
                <label>
                  <span className="sr-only">Tool name</span>
                  <Autocomplete
                    label="Tool name"
                    value={toolName}
                    onChange={setToolName}
                    options={TOOL_CATALOG}
                    placeholder="e.g. Air fryer, blender, chef’s knife"
                  />
                </label>
                <button className="button primary" disabled={!toolName.trim() || isSaving}>
                  <Plus size={18} />
                  Add tool
                </button>
              </form>
              {!inventory.tools.length ? (
                <div className="empty-state compact">
                  <div className="empty-basket">
                    <Utensils size={40} strokeWidth={1.3} />
                  </div>
                  <h2>What do you cook with?</h2>
                  <p>
                    Add your kitchen tools. They’ll be included
                    <br />
                    when you copy your inventory for Gemini.
                  </p>
                </div>
              ) : (
                inventory.tools.map((tool) => (
                  <div className="tool-row" key={tool.id}>
                    <span className="overview-icon">
                      <Utensils size={20} />
                    </span>
                    <strong>{tool.name}</strong>
                    <button
                      className="icon-button"
                      aria-label={`Remove ${tool.name}`}
                      onClick={() => setToolToDelete(tool.id)}
                    >
                      <Trash2 size={18} />
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
        <nav className="mobile-nav" aria-label="Mobile navigation">
          <button
            className={page === 'inventory' ? 'active' : ''}
            onClick={() => setPage('inventory')}
          >
            <Package size={20} />
            Inventory
          </button>
          <button className={page === 'recipes' ? 'active' : ''} onClick={() => setPage('recipes')}>
            <BookOpen size={20} /> Recipes
          </button>
          <button
            className={page === 'shopping' ? 'active' : ''}
            onClick={() => setPage('shopping')}
          >
            <ShoppingCart size={20} /> Shop
          </button>
          <button
            className={page === 'assistant' ? 'active' : ''}
            onClick={() => setPage('assistant')}
          >
            <Sparkles size={20} /> Gemini
          </button>
          <button className="mobile-scan" onClick={() => setScannerOpen(true)}>
            <ScanLine size={23} />
            Scan
          </button>
          <button className={page === 'tools' ? 'active' : ''} onClick={() => setPage('tools')}>
            <Utensils size={20} />
            Tools
          </button>
        </nav>
      </main>

      <ItemEditor
        editor={editor}
        draft={draft}
        onDraftChange={setDraft}
        onClose={closeEditor}
        suggestions={inventory.products.map((product) => product.name)}
        title={unknownScan ? 'Product not found' : undefined}
        description={unknownScan ?? undefined}
        submitLabel={unknownScan ? 'Add to review' : undefined}
        onSubmit={(event) => {
          void saveItem(event);
        }}
        onRemove={setDeleteBatch}
        busy={isSaving}
        error={formError}
      />
      <Modal
        open={!!usedBatch}
        onClose={() => {
          if (!isSaving) setUsedBatch(null);
        }}
        title={`Update ${currentUsedProduct?.name ?? 'quantity'}`}
        description="Keep what’s left in your kitchen accurate."
      >
        <form
          className="item-form"
          onSubmit={(event) => {
            void saveUsage(event);
          }}
        >
          <div className="segmented-control">
            <button
              type="button"
              disabled={currentUsedBatch?.quantity === null}
              className={usageMode === 'used' ? 'active' : ''}
              onClick={() => setUsageMode('used')}
            >
              Amount used
            </button>
            <button
              type="button"
              className={usageMode === 'remaining' ? 'active' : ''}
              onClick={() => setUsageMode('remaining')}
            >
              Amount remaining
            </button>
          </div>
          <p className="field-note">
            Current quantity:{' '}
            {currentUsedBatch
              ? formatQuantity(currentUsedBatch.quantity, currentUsedBatch.unit)
              : 'Unknown'}
          </p>
          <label>
            {usageMode === 'used' ? 'How much did you use?' : 'How much is left?'}
            <div className="input-with-unit">
              <input
                autoFocus
                type="number"
                min="0"
                step="any"
                required
                value={usageAmount}
                onChange={(event) => setUsageAmount(event.target.value)}
              />
              <span>{currentUsedBatch?.unit}</span>
            </div>
          </label>
          {currentUsedBatch?.quantity === null && (
            <p className="field-note">
              The starting quantity is unknown. Set the amount remaining.
            </p>
          )}
          {formError && (
            <p className="form-error" role="alert">
              {formError}
            </p>
          )}
          <div className="form-footer">
            <button
              type="button"
              className="button secondary"
              disabled={isSaving}
              onClick={() => setUsedBatch(null)}
            >
              Cancel
            </button>
            <button className="button primary" disabled={isSaving}>
              {isSaving ? 'Saving…' : 'Update quantity'}
            </button>
          </div>
        </form>
      </Modal>
      <Modal
        open={!!deleteBatch}
        onClose={() => setDeleteBatch(null)}
        title="Remove this batch?"
        description="Other purchase batches will stay in your inventory."
      >
        <div className="form-footer">
          <button
            className="button secondary"
            disabled={isSaving}
            onClick={() => setDeleteBatch(null)}
          >
            Keep item
          </button>
          <button
            className="button destructive"
            disabled={isSaving}
            onClick={() => {
              const id = deleteBatch!;
              void act(
                () => repository.update((state) => removeBatch(state, id)),
                'Batch removed.',
              ).then((saved) => {
                if (saved) {
                  setDeleteBatch(null);
                  setEditor(null);
                  setSelected((current) => current.filter((value) => value !== id));
                }
              });
            }}
          >
            Remove batch
          </button>
        </div>
      </Modal>
      <Modal
        open={!!toolToDelete}
        onClose={() => setToolToDelete(null)}
        title="Remove this tool?"
        description="You can add it again whenever you need."
      >
        <div className="form-footer">
          <button className="button secondary" onClick={() => setToolToDelete(null)}>
            Keep tool
          </button>
          <button
            className="button destructive"
            disabled={isSaving}
            onClick={() => {
              void act(
                () => repository.update((state) => removeTool(state, toolToDelete!)),
                'Tool removed.',
              ).then((saved) => {
                if (saved) setToolToDelete(null);
              });
            }}
          >
            Remove tool
          </button>
        </div>
      </Modal>
      <Modal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        title="Ready for Gemini"
        description="Your inventory, in simple Markdown. Paste it into any AI conversation."
        className="export-modal"
      >
        <div className="export-options">
          {selected.length > 0 && (
            <label className="inline-check">
              <input
                type="checkbox"
                checked={exportSelected}
                onChange={(event) => setExportSelected(event.target.checked)}
              />
              Only selected ingredients
            </label>
          )}
          <button
            className="text-button"
            onClick={() => download(markdown, `mise-inventory-${todayDate()}.md`, 'text/markdown')}
          >
            <ArrowDownToLine size={16} />
            Download .md
          </button>
        </div>
        <textarea
          ref={exportText}
          className="export-preview"
          aria-label="Copyable inventory Markdown"
          readOnly
          value={markdown}
          onFocus={(event) => event.target.select()}
        />
        <div className="form-footer">
          <a
            className="button secondary"
            href="https://gemini.google.com/app"
            target="_blank"
            rel="noopener noreferrer"
          >
            Open Gemini
            <ExternalLink size={15} />
          </a>
          <button
            className="button primary"
            onClick={() => {
              void copyInventory(exportSelected);
              exportText.current?.select();
            }}
          >
            <Clipboard size={17} />
            Copy inventory
          </button>
        </div>
      </Modal>
      <Modal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title="Your kitchen, your way"
        description="Manage Gemini and your kitchen backup."
        className="settings-modal"
      >
        <div className="settings-section">
          <div className="settings-section-heading">
            <Cloud size={21} />
            <div>
              <h3>Saved on this device</h3>
              <p>Local only · This browser has its own kitchen.</p>
            </div>
          </div>
          <p className="settings-note">
            Download a backup to keep a copy or transfer your kitchen to another device. Restoring a
            backup replaces that device’s kitchen.
          </p>
        </div>
        <GeminiSettings onToast={setToast} />
        <div className="settings-section">
          <h3>Keep a backup</h3>
          <p className="settings-note">
            A backup includes inventory, tools, saved recipes, meal plans, shopping lists, and your
            conversation. It can also move your kitchen to another device.
          </p>
          <div className="backup-actions">
            <button
              className="button secondary"
              onClick={() =>
                download(
                  JSON.stringify(
                    { ...buildInventoryBackup(inventory), exportedAt: new Date().toISOString() },
                    null,
                    2,
                  ),
                  `mise-backup-${todayDate()}.json`,
                  'application/json',
                )
              }
            >
              <ArrowDownToLine size={17} />
              Download backup
            </button>
            <button className="button secondary" onClick={() => fileInput.current?.click()}>
              Restore backup
            </button>
            <input
              ref={fileInput}
              className="sr-only"
              type="file"
              accept=".json,application/json"
              onChange={(event) => {
                void readBackup(event.target.files?.[0]);
              }}
            />
          </div>
        </div>
        <div className="settings-section">
          <h3>Bring your own AI</h3>
          <p className="settings-note">
            Copy your inventory into Gemini or any AI you prefer. Use your existing account and
            subscription.
          </p>
          <button
            className="text-button"
            onClick={() => {
              setSettingsOpen(false);
              setExportSelected(false);
              setExportOpen(true);
            }}
          >
            Preview inventory export
            <ArrowRight size={16} />
          </button>
        </div>
        <div className="settings-version">
          Mise 0.2 <span>Updates arrive at the same website address.</span>
        </div>
      </Modal>
      <Modal
        open={!!backupToImport}
        onClose={() => setBackupToImport(null)}
        title="Restore this kitchen?"
        description={`This backup contains ${backupToImport?.batches.length ?? 0} purchase batches, ${backupToImport?.recipes?.length ?? 0} saved recipes, and ${backupToImport?.shoppingList?.length ?? 0} shopping items.`}
      >
        <p className="settings-note">
          This replaces the kitchen you’re viewing, including saved recipes, lists, and
          conversation. Download a backup of your current kitchen first if you want to keep it.
        </p>
        <div className="form-footer">
          <button
            className="button secondary"
            disabled={isSaving}
            onClick={() => setBackupToImport(null)}
          >
            Cancel
          </button>
          <button
            className="button primary"
            disabled={isSaving}
            onClick={() => {
              const imported = backupToImport!;
              void act(() => repository.replace(imported), 'Kitchen restored.').then((saved) => {
                if (saved) {
                  setBackupToImport(null);
                  setSelected([]);
                  setExpanded(null);
                }
              });
            }}
          >
            Replace inventory
          </button>
        </div>
      </Modal>
      <Modal
        open={scannerOpen}
        onClose={() => {
          if (!isSaving) closeScanner();
        }}
        title="Stock up, simply"
        description="One intentional scan adds one package. Review everything before saving."
        className="scanner-modal"
      >
        {scannerOpen && (
          <Scanner
            onAdd={handleScanBarcode}
            onClose={closeScanner}
            tray={scanTray}
            packageCount={scanPackageCount}
          />
        )}
      </Modal>
      <Modal
        open={!!repeatScan}
        onClose={() => decideRepeat(false)}
        title={`Add another ${repeatScan?.name ?? 'item'}?`}
        description={
          repeatScan?.inTray
            ? 'This item is already in your review. Add one more package?'
            : 'You already have this item. Add a new package with its own purchase and expiration dates?'
        }
      >
        <div className="form-footer">
          <button className="button secondary" onClick={() => decideRepeat(false)}>
            Skip
          </button>
          <button className="button primary" onClick={() => decideRepeat(true)}>
            Add 1 package
          </button>
        </div>
      </Modal>
      {toast && (
        <div className="toast" role="status">
          <Check size={19} />
          <span>{toast}</span>
          {undoDeduction?.message === toast && (
            <button
              type="button"
              className="text-button"
              disabled={isSaving}
              onClick={() => {
                void undoLastDeduction();
              }}
            >
              <Undo2 size={16} /> Undo
            </button>
          )}
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setToast('')}
          >
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
