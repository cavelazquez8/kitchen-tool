import type { InventoryState } from '../domain/types';
import { createLocalRepository } from './localRepository';

export interface RepositoryUser {
  uid: string;
  displayName: string | null;
  email: string | null;
}

export interface RepositorySnapshot {
  state: InventoryState;
  mode: 'local' | 'cloud';
  status: 'ready' | 'loading' | 'saving' | 'error';
  user: RepositoryUser | null;
  error: string | null;
  cloudConfigured: boolean;
  localItemCount: number;
}

/** Reducers must be pure: Firestore may run them more than once. */
export type InventoryReducer = (state: InventoryState) => InventoryState;

export interface InventoryRepository {
  getSnapshot(): RepositorySnapshot;
  subscribe(listener: () => void): () => void;
  update(reducer: InventoryReducer): Promise<void>;
  /** Replace only after user confirmation; also repairs a malformed saved state. */
  replace(state: InventoryState): Promise<void>;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  /** Replacing an existing cloud inventory requires an explicit user confirmation. */
  importLocal(options?: { replaceExisting?: boolean }): Promise<void>;
}

let repository: InventoryRepository | undefined;

export function getInventoryRepository(): InventoryRepository {
  if (!repository) {
    repository = createLocalRepository();
  }
  return repository;
}

export function inventoryItemCount(state: InventoryState): number {
  return state.batches.length + state.tools.length;
}
