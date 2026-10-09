import { createEmptyInventory, isInventoryState } from '../domain/types';
import type { InventoryState } from '../domain/types';
import type { InventoryRepository, RepositorySnapshot } from './repository';

export const LOCAL_STORAGE_KEY = 'kitchen-wrapper.inventory.v1';
const LOCAL_LOCK_KEY = 'kitchen-wrapper.inventory.write';

interface LocalDocument {
  schemaVersion: 1;
  state: InventoryState;
}

function storageErrorMessage(error: unknown): string {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : '';
  if (name === 'QuotaExceededError')
    return 'Browser storage is full. Download a backup before clearing site data.';
  if (name === 'SecurityError')
    return 'Browser storage is blocked. Check this site’s storage settings.';
  return error instanceof Error ? error.message : 'Inventory could not be saved.';
}

function readInventory(storage: Storage): InventoryState {
  const raw = storage.getItem(LOCAL_STORAGE_KEY);
  if (!raw) return createEmptyInventory();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Saved inventory could not be read. Your original data has been kept.');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('schemaVersion' in parsed) ||
    parsed.schemaVersion !== 1 ||
    !('state' in parsed) ||
    !isInventoryState(parsed.state)
  ) {
    throw new Error('Saved inventory could not be read. Your original data has been kept.');
  }
  return parsed.state;
}

export function createLocalRepository(
  providedStorage?: Storage,
  configurationError: string | null = null,
): InventoryRepository {
  let storage: Storage | undefined;
  const listeners = new Set<() => void>();
  let snapshot: RepositorySnapshot = {
    state: createEmptyInventory(),
    mode: 'local',
    status: 'ready',
    user: null,
    error: configurationError,
    cloudConfigured: false,
    localItemCount: 0,
  };

  function publish(state: InventoryState, error: string | null = null) {
    snapshot = {
      ...snapshot,
      state,
      status: error ? 'error' : 'ready',
      error,
      localItemCount: state.batches.length + state.tools.length,
    };
    listeners.forEach((listener) => listener());
  }

  try {
    storage = providedStorage ?? window.localStorage;
    publish(readInventory(storage), configurationError);
  } catch {
    publish(snapshot.state, 'Saved inventory could not be read. Your original data has been kept.');
  }

  window.addEventListener('storage', (event) => {
    if (
      !storage ||
      (event.key !== null && event.key !== LOCAL_STORAGE_KEY) ||
      event.storageArea !== storage
    )
      return;
    try {
      publish(readInventory(storage));
    } catch {
      publish(
        snapshot.state,
        'Saved inventory could not be read. Your original data has been kept.',
      );
    }
  });

  let pending: Promise<void> = Promise.resolve();

  function save(reducer: (state: InventoryState) => InventoryState, replace = false) {
    const write = async () => {
      const apply = () => {
        try {
          if (!storage)
            throw new Error('Browser storage is unavailable. Check this site’s storage settings.');
          // Read again inside the lock so another tab's latest changes are preserved.
          const current = replace ? createEmptyInventory() : readInventory(storage);
          const next = reducer(structuredClone(current));
          if (!isInventoryState(next))
            throw new Error('Please check the item details and try again.');
          const document: LocalDocument = { schemaVersion: 1, state: next };
          storage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(document));
          publish(next);
        } catch (error) {
          const message = storageErrorMessage(error);
          publish(snapshot.state, message);
          throw new Error(message);
        }
      };
      if (typeof navigator !== 'undefined' && navigator.locks) {
        await navigator.locks.request(LOCAL_LOCK_KEY, apply);
      } else {
        apply();
      }
    };
    const result = pending.then(write, write);
    pending = result.catch(() => undefined);
    return result;
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(reducer) {
      return save(reducer);
    },
    replace(state) {
      if (!isInventoryState(state))
        return Promise.reject(new Error('That backup is not a valid kitchen inventory.'));
      const replacement = structuredClone(state);
      return save(() => replacement, true);
    },
    async signIn() {
      throw new Error(
        'Cloud sync has not been configured. Inventory is saved in this browser only.',
      );
    },
    async signOut() {},
    async importLocal() {
      throw new Error('Sign in to cloud sync before transferring browser inventory.');
    },
  };
}
