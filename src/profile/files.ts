import { MAX_BODY_SCAN_FILE_BYTES, type BodyScanFile, type BodyScanMimeType } from './types';

const DATABASE_NAME = 'mise-profile-documents.v1';
const STORE_NAME = 'documents';

export interface BodyScanFileStore {
  read(id: string): Promise<Blob | null>;
  write(id: string, blob: Blob): Promise<void>;
  remove(id: string): Promise<void>;
}

function storageError(error: unknown): Error {
  if (error instanceof DOMException && error.name === 'QuotaExceededError')
    return new Error('Browser storage is full. Download a backup or remove an older body scan.');
  return new Error(
    'Your browser could not access the body scan files. Allow site storage, or save pasted report text instead.',
  );
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(storageError(null));
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DATABASE_NAME, 1);
    } catch (error) {
      reject(storageError(error));
      return;
    }
    let blocked = false;
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME))
        request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => {
      if (blocked) request.result.close();
      else resolve(request.result);
    };
    request.onerror = () => reject(storageError(request.error));
    request.onblocked = () => {
      blocked = true;
      reject(new Error('Close other Mise tabs, then try saving this body scan again.'));
    };
  });
}

async function transaction<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      let transaction: IDBTransaction;
      let request: IDBRequest<T>;
      try {
        transaction = database.transaction(STORE_NAME, mode);
        request = operation(transaction.objectStore(STORE_NAME));
      } catch (error) {
        reject(storageError(error));
        return;
      }
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(storageError(transaction.error ?? request.error));
      transaction.onerror = () => reject(storageError(transaction.error ?? request.error));
    });
  } finally {
    database.close();
  }
}

export const bodyScanFileStore: BodyScanFileStore = {
  async read(id) {
    const result: unknown = await transaction('readonly', (store) => store.get(id));
    if (result === undefined) return null;
    if (!(result instanceof Blob)) throw new Error('This saved body scan file could not be read.');
    return result;
  },
  async write(id, blob) {
    await transaction('readwrite', (store) => store.put(blob, id));
  },
  async remove(id) {
    await transaction('readwrite', (store) => store.delete(id));
  },
};

export async function readBlobBytes(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(new Uint8Array(reader.result));
      else reject(new Error('This body scan file could not be read.'));
    };
    reader.onerror = () => reject(new Error('This body scan file could not be read.'));
    reader.readAsArrayBuffer(blob);
  });
}

/** Confirm the bytes as well as the extension so renamed HTML cannot become a report preview. */
export async function validateBodyScanFile(file: Blob, name?: string): Promise<BodyScanMimeType> {
  if (file.size <= 0) throw new Error('This body scan file is empty. Choose another file.');
  if (file.size > MAX_BODY_SCAN_FILE_BYTES)
    throw new Error('Choose a body scan PDF or picture smaller than 4 MB.');
  if (name !== undefined && (!name.trim() || name.length > 240))
    throw new Error('Choose a body scan file with a name shorter than 240 characters.');
  const bytes = await readBlobBytes(file.slice(0, 1024));
  let mimeType: BodyScanMimeType | null = null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) mimeType = 'image/jpeg';
  else if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte))
    mimeType = 'image/png';
  else if (
    [82, 73, 70, 70].every((byte, index) => bytes[index] === byte) &&
    [87, 69, 66, 80].every((byte, index) => bytes[index + 8] === byte)
  )
    mimeType = 'image/webp';
  else {
    const header = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
    if (header.includes('%PDF-')) mimeType = 'application/pdf';
  }
  if (!mimeType)
    throw new Error(
      'Choose a PDF, JPEG, PNG, or WebP body scan. Other file types are not supported.',
    );
  if (file.type && file.type !== mimeType && file.type !== 'application/octet-stream')
    throw new Error(
      'This file does not match its declared format. Choose the original PDF or picture.',
    );
  return mimeType;
}

export async function saveBodyScanFile(file: File): Promise<BodyScanFile> {
  const mimeType = await validateBodyScanFile(file, file.name);
  const reference: BodyScanFile = {
    id: crypto.randomUUID(),
    name: file.name,
    mimeType,
    size: file.size,
  };
  await bodyScanFileStore.write(reference.id, file.slice(0, file.size, mimeType));
  return reference;
}

export function readBodyScanFile(id: string): Promise<Blob | null> {
  return bodyScanFileStore.read(id);
}

export function deleteBodyScanFile(id: string): Promise<void> {
  return bodyScanFileStore.remove(id);
}
