import { useSyncExternalStore } from 'react';
import { getInventoryRepository } from './repository';

export function useInventoryRepository() {
  const repository = getInventoryRepository();
  return useSyncExternalStore(repository.subscribe, repository.getSnapshot, repository.getSnapshot);
}
