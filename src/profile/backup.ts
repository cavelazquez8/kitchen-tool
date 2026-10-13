import { isInventoryState, type InventoryState } from '../domain/types';
import { buildInventoryBackup, type InventoryBackup } from '../lib/backup';
import {
  bodyScanFileStore,
  readBlobBytes,
  validateBodyScanFile,
  type BodyScanFileStore,
} from './files';
import { isBodyScanFile, MAX_BODY_SCANS, type BodyScanFile } from './types';

/** Twenty 4 MB originals as base64, with room for existing kitchen records. */
export const MAX_PROFILE_BACKUP_BYTES = 120_000_000;

export interface BodyScanBackupDocument extends BodyScanFile {
  data: string;
}

export interface ProfileBackup extends InventoryBackup {
  documents?: BodyScanBackupDocument[];
}

export interface StagedProfileRestore {
  inventory: InventoryState;
  /** Run after the inventory replacement succeeds; releases replaced originals. */
  commit(): Promise<void>;
  /** Run if replacement fails; the previous originals remain untouched. */
  rollback(): Promise<void>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function copyDocument(document: BodyScanBackupDocument): BodyScanBackupDocument {
  return {
    id: document.id,
    name: document.name,
    mimeType: document.mimeType,
    size: document.size,
    data: document.data,
  };
}

function isBackupDocument(value: unknown): value is BodyScanBackupDocument {
  if (
    !record(value) ||
    Object.keys(value).some((key) => !['id', 'name', 'mimeType', 'size', 'data'].includes(key))
  )
    return false;
  const { id, name, mimeType, size, data } = value;
  return (
    isBodyScanFile({ id, name, mimeType, size }) &&
    typeof data === 'string' &&
    data.length === 4 * Math.ceil((size as number) / 3) &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(data)
  );
}

function encodeBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 16_384)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
  return btoa(binary);
}

function decodeDocument(document: BodyScanBackupDocument): Blob {
  let binary: string;
  try {
    binary = atob(document.data);
  } catch {
    throw new Error(`The original file for “${document.name}” is damaged in this backup.`);
  }
  if (binary.length !== document.size || btoa(binary) !== document.data)
    throw new Error(`The original file for “${document.name}” is damaged in this backup.`);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: document.mimeType });
}

/** Old v1/v2 backups and plain InventoryState exports stay readable. */
export function parseProfileBackup(value: unknown): ProfileBackup {
  if (!record(value)) throw new Error('That file is not a valid Mise inventory backup.');
  const wrapped = 'inventory' in value;
  if (wrapped && value.version !== 1 && value.version !== 2)
    throw new Error('This backup uses a different format. Update Mise before restoring it.');
  const state: unknown = wrapped ? value.inventory : value;
  if (!isInventoryState(state)) throw new Error('That file is not a valid Mise inventory backup.');
  const inventory = buildInventoryBackup(state).inventory;
  const documents: unknown = wrapped ? value.documents : undefined;
  if (
    documents !== undefined &&
    (!Array.isArray(documents) ||
      documents.length > MAX_BODY_SCANS ||
      !documents.every(isBackupDocument))
  )
    throw new Error('The body scan files in this backup are not valid.');
  const copied = (documents as BodyScanBackupDocument[] | undefined)?.map(copyDocument) ?? [];
  const fileIds = new Set<string>();
  const expected = new Map(
    (inventory.bodyScans ?? []).flatMap((scan) =>
      scan.file ? [[scan.file.id, scan.file] as const] : [],
    ),
  );
  for (const document of copied) {
    const reference = expected.get(document.id);
    if (
      fileIds.has(document.id) ||
      !reference ||
      reference.name !== document.name ||
      reference.mimeType !== document.mimeType ||
      reference.size !== document.size
    )
      throw new Error('The body scan files do not match the reports in this backup.');
    fileIds.add(document.id);
  }
  if (fileIds.size !== expected.size)
    throw new Error(
      'Original body scan files are missing from this backup. Export a new backup from the device that has them.',
    );
  return {
    version: 2,
    inventory,
    ...(copied.length ? { documents: copied } : {}),
  };
}

/** Includes originals only on an explicit backup action, never in localStorage. */
export async function buildProfileBackup(
  state: InventoryState,
  store: BodyScanFileStore = bodyScanFileStore,
): Promise<ProfileBackup> {
  const backup = buildInventoryBackup(state);
  const documents: BodyScanBackupDocument[] = [];
  for (const scan of backup.inventory.bodyScans ?? []) {
    if (!scan.file) continue;
    const blob = await store.read(scan.file.id);
    if (!blob)
      throw new Error(
        `The original for “${scan.name}” is missing from this browser. Reattach the file or remove that report before exporting.`,
      );
    const mimeType = await validateBodyScanFile(blob, scan.file.name);
    if (blob.size !== scan.file.size || mimeType !== scan.file.mimeType)
      throw new Error(
        `The original for “${scan.name}” does not match its saved record. Reattach the file before exporting.`,
      );
    documents.push({ ...scan.file, data: encodeBytes(await readBlobBytes(blob)) });
  }
  return { ...backup, ...(documents.length ? { documents } : {}) };
}

/**
 * Store fresh IDs before replacing metadata, so a failed restore cannot overwrite
 * current originals. Root commits or rolls back after its repository replacement.
 */
export async function stageProfileBackupFiles(
  backup: ProfileBackup,
  previous?: InventoryState,
  store: BodyScanFileStore = bodyScanFileStore,
): Promise<StagedProfileRestore> {
  const validated = parseProfileBackup(backup);
  const decoded: { document: BodyScanBackupDocument; blob: Blob }[] = [];
  for (const document of validated.documents ?? []) {
    const blob = decodeDocument(document);
    if ((await validateBodyScanFile(blob, document.name)) !== document.mimeType)
      throw new Error(`The original file for “${document.name}” is not a supported body scan.`);
    decoded.push({ document, blob });
  }
  const remapped = new Map<string, string>();
  const written: string[] = [];
  try {
    for (const { document, blob } of decoded) {
      const id = crypto.randomUUID();
      await store.write(id, blob);
      remapped.set(document.id, id);
      written.push(id);
    }
  } catch (error) {
    await Promise.allSettled(written.map((id) => store.remove(id)));
    throw error;
  }
  const inventory = validated.inventory;
  if (inventory.bodyScans)
    inventory.bodyScans = inventory.bodyScans.map((scan) => ({
      ...scan,
      ...(scan.file ? { file: { ...scan.file, id: remapped.get(scan.file.id)! } } : {}),
    }));
  let finalized = false;
  return {
    inventory,
    async commit() {
      if (finalized) return;
      finalized = true;
      // A cleanup failure leaves only an unreachable old file, never missing new data.
      await Promise.allSettled(
        (previous?.bodyScans ?? []).flatMap((scan) =>
          scan.file ? [store.remove(scan.file.id)] : [],
        ),
      );
    },
    async rollback() {
      if (finalized) return;
      finalized = true;
      await Promise.allSettled(written.map((id) => store.remove(id)));
    },
  };
}
