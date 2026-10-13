import { copyNutritionValues, isNutritionTargets, type NutritionTargets } from '../nutrition/types';

export const MAX_BODY_SCANS = 20;
export const MAX_BODY_SCAN_TEXT_LENGTH = 24_000;
export const MAX_BODY_SCAN_FILE_BYTES = 4_000_000;
export const BODY_SCAN_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;
export type BodyScanMimeType = (typeof BODY_SCAN_MIME_TYPES)[number];

/** The original is kept separately in this browser's IndexedDB document store. */
export interface BodyScanFile {
  id: string;
  name: string;
  mimeType: BodyScanMimeType;
  size: number;
}

/** User-reviewed report text; targets are recorded recommendations, not inferred goals. */
export interface BodyScan {
  id: string;
  name: string;
  recordedOn: string | null;
  text: string;
  file?: BodyScanFile;
  targets?: NutritionTargets;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

function dateOnly(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export function isBodyScanFile(value: unknown): value is BodyScanFile {
  return (
    record(value) &&
    onlyKeys(value, ['id', 'name', 'mimeType', 'size']) &&
    text(value.id, 100) &&
    text(value.name, 240) &&
    BODY_SCAN_MIME_TYPES.includes(value.mimeType as BodyScanMimeType) &&
    Number.isSafeInteger(value.size) &&
    (value.size as number) > 0 &&
    (value.size as number) <= MAX_BODY_SCAN_FILE_BYTES
  );
}

export function isBodyScan(value: unknown): value is BodyScan {
  return (
    record(value) &&
    onlyKeys(value, ['id', 'name', 'recordedOn', 'text', 'file', 'targets']) &&
    text(value.id, 100) &&
    text(value.name, 160) &&
    (value.recordedOn === null || dateOnly(value.recordedOn)) &&
    typeof value.text === 'string' &&
    value.text.length <= MAX_BODY_SCAN_TEXT_LENGTH &&
    (value.file === undefined || isBodyScanFile(value.file)) &&
    (value.text.trim().length > 0 || value.file !== undefined) &&
    (value.targets === undefined || isNutritionTargets(value.targets))
  );
}

export function isBodyScanCollection(value: unknown): value is BodyScan[] {
  if (!Array.isArray(value) || value.length > MAX_BODY_SCANS || !value.every(isBodyScan))
    return false;
  const ids = new Set<string>();
  const fileIds = new Set<string>();
  for (const scan of value) {
    if (ids.has(scan.id) || (scan.file !== undefined && fileIds.has(scan.file.id))) return false;
    ids.add(scan.id);
    if (scan.file) fileIds.add(scan.file.id);
  }
  return true;
}

export function copyBodyScan(scan: BodyScan): BodyScan {
  return {
    id: scan.id,
    name: scan.name,
    recordedOn: scan.recordedOn,
    text: scan.text,
    ...(scan.file
      ? {
          file: {
            id: scan.file.id,
            name: scan.file.name,
            mimeType: scan.file.mimeType,
            size: scan.file.size,
          },
        }
      : {}),
    ...(scan.targets ? { targets: copyNutritionValues(scan.targets) } : {}),
  };
}
