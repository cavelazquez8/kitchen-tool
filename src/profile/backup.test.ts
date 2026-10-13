import { describe, expect, it, vi } from 'vitest';
import { type InventoryState } from '../domain/types';
import { buildInventoryBackup } from '../lib/backup';
import {
  buildProfileBackup,
  parseProfileBackup,
  stageProfileBackupFiles,
  type ProfileBackup,
} from './backup';
import { type BodyScanFileStore } from './files';
import { type BodyScan } from './types';

const pdfText = '%PDF-1.7\nNonpersonal test document';
const scan: BodyScan = {
  id: 'report-one',
  name: 'Saved report',
  recordedOn: null,
  text: 'Reviewed report text',
  file: {
    id: 'original-one',
    name: 'example.pdf',
    mimeType: 'application/pdf',
    size: pdfText.length,
  },
};
const state: InventoryState = { products: [], batches: [], tools: [], bodyScans: [scan] };

function memoryStore(entries: [string, Blob][] = []) {
  const files = new Map(entries);
  const store: BodyScanFileStore = {
    read: vi.fn(async (id: string) => files.get(id) ?? null),
    write: vi.fn(async (id: string, blob: Blob) => {
      files.set(id, blob);
    }),
    remove: vi.fn(async (id: string) => {
      files.delete(id);
    }),
  };
  return { files, store };
}

function validBackup(): ProfileBackup {
  return {
    ...buildInventoryBackup(state),
    documents: [{ ...scan.file!, data: btoa(pdfText) }],
  };
}

describe('body scan backup transfer', () => {
  it('includes originals with metadata and strips unrelated top-level settings on import', async () => {
    const { store } = memoryStore([
      ['original-one', new Blob([pdfText], { type: 'application/pdf' })],
    ]);
    const backup = await buildProfileBackup(state, store);
    expect(backup).toEqual(validBackup());
    expect(parseProfileBackup({ ...backup, connection: { token: 'secret' } })).toEqual(backup);
  });

  it('keeps v1, v2, and plain inventories without reports compatible', () => {
    const old = { products: [], batches: [], tools: [{ id: 'pan', name: 'Pan' }] };
    for (const input of [old, { version: 1, inventory: old }, { version: 2, inventory: old }])
      expect(parseProfileBackup(input)).toEqual({ version: 2, inventory: old });
    expect(() => parseProfileBackup({ version: 3, inventory: old })).toThrow('different format');
  });

  it('exports text-only reports without requiring IndexedDB', async () => {
    const textOnly: InventoryState = {
      products: [],
      batches: [],
      tools: [],
      bodyScans: [{ id: 'text', name: 'Pasted report', recordedOn: null, text: 'Saved text' }],
    };
    const { store } = memoryStore();
    const backup = await buildProfileBackup(textOnly, store);
    expect(backup.documents).toBeUndefined();
    expect(store.read).not.toHaveBeenCalled();
    expect(parseProfileBackup(backup).inventory).toEqual(textOnly);
  });

  it('refuses missing originals or mismatched document references rather than losing reports', async () => {
    await expect(buildProfileBackup(state, memoryStore().store)).rejects.toThrow('missing');
    expect(() => parseProfileBackup(buildInventoryBackup(state))).toThrow('missing');
    const backup = validBackup();
    expect(() =>
      parseProfileBackup({ ...backup, documents: [backup.documents![0], backup.documents![0]] }),
    ).toThrow('do not match');
    expect(() =>
      parseProfileBackup({
        ...backup,
        documents: [{ ...backup.documents![0], name: 'changed.pdf' }],
      }),
    ).toThrow('do not match');
  });

  it('stages fresh file IDs and rolls back without touching previous originals', async () => {
    const original = new Blob([pdfText], { type: 'application/pdf' });
    const { files, store } = memoryStore([['original-one', original]]);
    const restore = await stageProfileBackupFiles(validBackup(), state, store);
    const newId = restore.inventory.bodyScans![0].file!.id;
    expect(newId).not.toBe('original-one');
    expect(files.has(newId)).toBe(true);
    expect(files.get('original-one')).toBe(original);
    await restore.rollback();
    expect(files.has(newId)).toBe(false);
    expect(files.get('original-one')).toBe(original);
    await restore.commit();
    expect(files.get('original-one')).toBe(original);
  });

  it('commits the new originals before cleaning replaced files', async () => {
    const { files, store } = memoryStore([
      ['original-one', new Blob([pdfText], { type: 'application/pdf' })],
    ]);
    const restore = await stageProfileBackupFiles(validBackup(), state, store);
    const newId = restore.inventory.bodyScans![0].file!.id;
    await restore.commit();
    expect(files.has('original-one')).toBe(false);
    expect(files.has(newId)).toBe(true);
    await restore.rollback();
    expect(files.has(newId)).toBe(true);
  });

  it('validates every original before writing any staged files', async () => {
    const html = '<html>not a report</html>';
    const backup = validBackup();
    backup.inventory.bodyScans!.push({
      ...scan,
      id: 'two',
      file: { ...scan.file!, id: 'two-file', size: html.length },
    });
    backup.documents!.push({ ...scan.file!, id: 'two-file', size: html.length, data: btoa(html) });
    const { store } = memoryStore();
    await expect(stageProfileBackupFiles(backup, state, store)).rejects.toThrow('Choose a PDF');
    expect(store.write).not.toHaveBeenCalled();
  });

  it('cleans partial staging when browser storage fills up', async () => {
    const backup = validBackup();
    backup.inventory.bodyScans!.push({
      ...scan,
      id: 'two',
      file: { ...scan.file!, id: 'two-file' },
    });
    backup.documents!.push({ ...scan.file!, id: 'two-file', data: btoa(pdfText) });
    const { files, store } = memoryStore([
      ['original-one', new Blob([pdfText], { type: 'application/pdf' })],
    ]);
    vi.mocked(store.write).mockImplementationOnce(async (id, blob) => {
      files.set(id, blob);
    });
    vi.mocked(store.write).mockRejectedValueOnce(new Error('Storage full'));
    await expect(stageProfileBackupFiles(backup, state, store)).rejects.toThrow('Storage full');
    expect([...files.keys()]).toEqual(['original-one']);
  });

  it('rejects invalid base64 content before storage writes', async () => {
    const backup = validBackup();
    backup.documents![0].data = 'x'.repeat(backup.documents![0].data.length - 1) + '=';
    const { store } = memoryStore();
    await expect(stageProfileBackupFiles(backup, state, store)).rejects.toThrow();
    expect(store.write).not.toHaveBeenCalled();
  });
});
