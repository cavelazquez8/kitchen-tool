import { readFileSync } from 'node:fs';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, runTransaction, serverTimestamp, setDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createEmptyInventory } from '../domain/types';

let environment: RulesTestEnvironment;

beforeAll(async () => {
  environment = await initializeTestEnvironment({
    projectId: 'demo-kitchen',
    firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8') },
  });
});
beforeEach(async () => environment.clearFirestore());
afterAll(async () => environment?.cleanup());

function validDocument(revision = 1) {
  return {
    schemaVersion: 1,
    revision,
    state: createEmptyInventory(),
    updatedAt: serverTimestamp(),
  };
}

describe('kitchen ownership and cloud transactions', () => {
  it('allows the owner to create and read while blocking other accounts and guests', async () => {
    const alice = environment.authenticatedContext('alice').firestore();
    await assertSucceeds(setDoc(doc(alice, 'users/alice/kitchen/inventory'), validDocument()));
    await assertSucceeds(getDoc(doc(alice, 'users/alice/kitchen/inventory')));
    const bob = environment.authenticatedContext('bob').firestore();
    await assertFails(getDoc(doc(bob, 'users/alice/kitchen/inventory')));
    await assertFails(setDoc(doc(bob, 'users/alice/kitchen/inventory'), validDocument(2)));
    const guest = environment.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(guest, 'users/alice/kitchen/inventory')));
    await assertFails(setDoc(doc(guest, 'users/guest/kitchen/inventory'), validDocument()));
  });

  it('rejects malformed envelopes and invalid revisions', async () => {
    const db = environment.authenticatedContext('alice').firestore();
    const reference = doc(db, 'users/alice/kitchen/inventory');
    await assertFails(setDoc(reference, { ...validDocument(), schemaVersion: 99 }));
    await assertFails(
      setDoc(reference, { ...validDocument(), state: { products: [], batches: 'bad', tools: [] } }),
    );
    await assertSucceeds(setDoc(reference, validDocument()));
    await assertFails(setDoc(reference, validDocument(0)));
    await assertSucceeds(setDoc(reference, validDocument(2)));
  });

  it('preserves both changes when simultaneous transactions update the kitchen', async () => {
    const db = environment.authenticatedContext('alice').firestore();
    const reference = doc(db, 'users/alice/kitchen/inventory');
    await setDoc(reference, validDocument());
    await Promise.all(
      ['pan', 'pot'].map((id) =>
        runTransaction(db, async (transaction) => {
          const current = (await transaction.get(reference)).data()!;
          transaction.set(reference, {
            ...current,
            revision: current.revision + 1,
            state: { ...current.state, tools: [...current.state.tools, { id, name: id }] },
            updatedAt: serverTimestamp(),
          });
        }),
      ),
    );
    const saved = (await getDoc(reference)).data()!;
    expect(saved.revision).toBe(3);
    expect(saved.state.tools.map((tool: { id: string }) => tool.id).sort()).toEqual(['pan', 'pot']);
  });
});
