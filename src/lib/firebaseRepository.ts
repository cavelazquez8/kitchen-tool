import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import { doc, onSnapshot, runTransaction, serverTimestamp } from 'firebase/firestore';
import type { User } from 'firebase/auth';
import type { DocumentData } from 'firebase/firestore';
import { createEmptyInventory, isInventoryState } from '../domain/types';
import type { InventoryState } from '../domain/types';
import type { FirebaseServices } from './firebase';
import type { InventoryReducer, InventoryRepository, RepositorySnapshot } from './repository';

function errorMessage(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code === 'auth/popup-blocked') return 'Allow pop-ups for this site, then sign in again.';
  if (code === 'auth/popup-closed-by-user')
    return 'Sign-in was closed. Your browser inventory is safe.';
  if (code === 'auth/unauthorized-domain') return 'Sign-in is not configured for this website yet.';
  if (code === 'permission-denied')
    return 'Cloud access is unavailable. Please check the account configuration.';
  if (code === 'unavailable' || code === 'auth/network-request-failed') {
    return 'Could not connect. Check your internet connection and try again.';
  }
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

function readDocument(data: DocumentData | undefined): { revision: number; state: InventoryState } {
  if (!data) return { revision: 0, state: createEmptyInventory() };
  if (
    data.schemaVersion !== 1 ||
    !Number.isInteger(data.revision) ||
    data.revision < 1 ||
    !isInventoryState(data.state)
  ) {
    throw new Error('Cloud inventory could not be read. Your original data has been kept.');
  }
  return { revision: data.revision as number, state: data.state };
}

function replacementRevision(data: DocumentData | undefined): number {
  if (!data) return 0;
  if (data.schemaVersion !== 1) {
    throw new Error(
      'This kitchen uses a different format. Update the app before restoring a backup.',
    );
  }
  if (!Number.isInteger(data.revision) || data.revision < 1) {
    throw new Error(
      'Cloud inventory metadata could not be read. Your original data has been kept.',
    );
  }
  return data.revision as number;
}

export function createFirebaseRepository(
  local: InventoryRepository,
  services: FirebaseServices,
): InventoryRepository {
  const listeners = new Set<() => void>();
  let snapshot: RepositorySnapshot = {
    ...local.getSnapshot(),
    cloudConfigured: true,
    status: 'loading',
  };
  let user: User | null = null;
  let epoch = 0;
  let pendingWrites = 0;
  let stopCloud: (() => void) | undefined;

  function publish(next: Partial<RepositorySnapshot>) {
    snapshot = { ...snapshot, ...next };
    listeners.forEach((listener) => listener());
  }

  local.subscribe(() => {
    if (!user) publish({ ...local.getSnapshot(), cloudConfigured: true });
    else publish({ localItemCount: local.getSnapshot().localItemCount });
  });

  onAuthStateChanged(
    services.auth,
    (nextUser) => {
      epoch += 1;
      const currentEpoch = epoch;
      stopCloud?.();
      stopCloud = undefined;
      user = nextUser;
      if (!nextUser) {
        publish({ ...local.getSnapshot(), cloudConfigured: true });
        return;
      }
      publish({
        mode: 'cloud',
        state: createEmptyInventory(),
        status: 'loading',
        error: null,
        user: { uid: nextUser.uid, displayName: nextUser.displayName, email: nextUser.email },
      });
      const reference = doc(services.firestore, 'users', nextUser.uid, 'kitchen', 'inventory');
      stopCloud = onSnapshot(
        reference,
        { includeMetadataChanges: true },
        (document) => {
          if (currentEpoch !== epoch) return;
          try {
            const decoded = readDocument(document.exists() ? document.data() : undefined);
            publish({
              state: decoded.state,
              status: pendingWrites ? 'saving' : document.metadata.fromCache ? 'loading' : 'ready',
              error: null,
            });
          } catch (error) {
            publish({ status: 'error', error: errorMessage(error) });
          }
        },
        (error) => {
          if (currentEpoch === epoch) publish({ status: 'error', error: errorMessage(error) });
        },
      );
    },
    (error) => publish({ status: 'error', error: errorMessage(error) }),
  );

  async function save(reducer: InventoryReducer, replace = false) {
    if (!user)
      return replace ? local.replace(reducer(createEmptyInventory())) : local.update(reducer);
    if (!navigator.onLine) throw new Error('Connect to the internet to save cloud changes.');
    if (snapshot.status === 'loading')
      throw new Error('Your inventory is still loading. Try again in a moment.');
    const currentEpoch = epoch;
    const reference = doc(services.firestore, 'users', user.uid, 'kitchen', 'inventory');
    pendingWrites += 1;
    publish({ status: 'saving', error: null });
    try {
      await runTransaction(services.firestore, async (transaction) => {
        if (currentEpoch !== epoch) throw new Error('Your account changed. Please try again.');
        const document = await transaction.get(reference);
        const data = document.exists() ? document.data() : undefined;
        const current = replace
          ? { revision: replacementRevision(data), state: createEmptyInventory() }
          : readDocument(data);
        const state = reducer(structuredClone(current.state));
        if (!isInventoryState(state))
          throw new Error('Please check the item details and try again.');
        transaction.set(reference, {
          schemaVersion: 1,
          revision: current.revision + 1,
          state: JSON.parse(JSON.stringify(state)) as InventoryState,
          updatedAt: serverTimestamp(),
        });
      });
      if (currentEpoch === epoch)
        publish({ status: pendingWrites > 1 ? 'saving' : 'ready', error: null });
    } catch (error) {
      const message = errorMessage(error);
      if (currentEpoch === epoch) publish({ status: 'error', error: message });
      throw new Error(message);
    } finally {
      pendingWrites -= 1;
    }
  }

  const repository: InventoryRepository = {
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
      try {
        await signInWithPopup(services.auth, new GoogleAuthProvider());
      } catch (error) {
        const message = errorMessage(error);
        publish({ error: message });
        throw new Error(message);
      }
    },
    async signOut() {
      if (pendingWrites)
        throw new Error('Wait for your changes to finish saving before signing out.');
      await signOut(services.auth);
    },
    async importLocal(options) {
      if (!user) throw new Error('Sign in before transferring browser inventory.');
      const localSnapshot = local.getSnapshot();
      if (localSnapshot.error) throw new Error(localSnapshot.error);
      const source = structuredClone(localSnapshot.state);
      await repository.update((current) => {
        if (
          !options?.replaceExisting &&
          (current.products.length || current.batches.length || current.tools.length)
        ) {
          throw new Error(
            'Cloud inventory already contains items. Your browser copy has been kept separate.',
          );
        }
        return source;
      });
    },
  };
  return repository;
}
