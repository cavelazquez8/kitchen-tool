import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalRepository, LOCAL_STORAGE_KEY } from './localRepository';

describe('browser inventory persistence', () => {
  beforeEach(() => localStorage.clear());

  it('starts empty and preserves inventory across repository instances', async () => {
    const repository = createLocalRepository();
    expect(repository.getSnapshot().state.batches).toEqual([]);
    await repository.update((state) => ({ ...state, tools: [{ id: 'pan', name: 'Frying pan' }] }));
    const reloaded = createLocalRepository();
    expect(reloaded.getSnapshot().state.tools).toEqual([{ id: 'pan', name: 'Frying pan' }]);
    expect(reloaded.getSnapshot().mode).toBe('local');
    expect(reloaded.getSnapshot().cloudConfigured).toBe(false);
  });

  it('applies queued updates to the latest saved state', async () => {
    const repository = createLocalRepository();
    await Promise.all([
      repository.update((state) => ({
        ...state,
        tools: [...state.tools, { id: 'pan', name: 'Pan' }],
      })),
      repository.update((state) => ({
        ...state,
        tools: [...state.tools, { id: 'pot', name: 'Pot' }],
      })),
    ]);
    expect(repository.getSnapshot().state.tools.map((tool) => tool.id)).toEqual(['pan', 'pot']);
  });

  it('does not overwrite malformed saved data', async () => {
    const original = '{broken json';
    localStorage.setItem(LOCAL_STORAGE_KEY, original);
    const repository = createLocalRepository();
    expect(repository.getSnapshot().status).toBe('error');
    await expect(repository.update((state) => state)).rejects.toThrow();
    expect(localStorage.getItem(LOCAL_STORAGE_KEY)).toBe(original);
  });

  it('restores a validated backup over malformed storage only through explicit replacement', async () => {
    localStorage.setItem(LOCAL_STORAGE_KEY, '{broken json');
    const repository = createLocalRepository();
    await repository.replace({ products: [], batches: [], tools: [{ id: 'pot', name: 'Pot' }] });
    expect(repository.getSnapshot().status).toBe('ready');
    expect(createLocalRepository().getSnapshot().state.tools).toEqual([{ id: 'pot', name: 'Pot' }]);
  });

  it('retains the previous snapshot when browser storage cannot save', async () => {
    const repository = createLocalRepository();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Browser storage is full', 'QuotaExceededError');
    });
    await expect(
      repository.update((state) => ({
        ...state,
        tools: [{ id: 'pot', name: 'Pot' }],
      })),
    ).rejects.toThrow('Browser storage is full');
    expect(repository.getSnapshot().state.tools).toEqual([]);
    expect(repository.getSnapshot().status).toBe('error');
  });

  it('notifies subscribers only with saved changes and supports unsubscribe', async () => {
    const repository = createLocalRepository();
    const listener = vi.fn();
    const unsubscribe = repository.subscribe(listener);
    const initial = repository.getSnapshot();
    expect(repository.getSnapshot()).toBe(initial);
    await repository.update((state) => ({ ...state, tools: [{ id: 'pot', name: 'Pot' }] }));
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    await repository.update((state) => ({ ...state, tools: [] }));
    expect(listener).toHaveBeenCalledOnce();
  });
});
