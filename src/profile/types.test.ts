import { describe, expect, it } from 'vitest';
import { isInventoryState, type InventoryState } from '../domain/types';
import { createLocalRepository } from '../lib/localRepository';
import { buildInventoryBackup } from '../lib/backup';
import {
  copyBodyScan,
  isBodyScan,
  isBodyScanCollection,
  MAX_BODY_SCANS,
  MAX_BODY_SCAN_TEXT_LENGTH,
  type BodyScan,
} from './types';

const report: BodyScan = {
  id: 'report-one',
  name: 'Reviewed report',
  recordedOn: '2024-02-29',
  text: 'Example report text. No recommended daily intake was recorded.',
};

describe('profile report records', () => {
  it('persists multiple reports without changing approved daily targets', async () => {
    localStorage.clear();
    const repository = createLocalRepository();
    const targets = { caloriesKcal: 2100, proteinGrams: 100, carbsGrams: null, fatGrams: null };
    await repository.update((state) => ({
      ...state,
      nutritionTargets: targets,
      bodyScans: [report, { ...report, id: 'report-two', name: 'Follow-up', recordedOn: null }],
    }));
    const restored = createLocalRepository().getSnapshot().state;
    expect(restored.bodyScans).toHaveLength(2);
    expect(restored.nutritionTargets).toEqual(targets);
    expect(restored.bodyScans?.[0].targets).toBeUndefined();
  });

  it('accepts an original awaiting extraction but rejects an empty text-only report', () => {
    const empty = { ...report, text: '' };
    expect(isBodyScan(empty)).toBe(false);
    expect(
      isBodyScan({
        ...empty,
        file: { id: 'file-one', name: 'report.pdf', mimeType: 'application/pdf', size: 100 },
      }),
    ).toBe(true);
  });

  it('rejects impossible dates, duplicate references, unbounded text, and guessed targets', () => {
    expect(isBodyScan({ ...report, recordedOn: '2025-02-29' })).toBe(false);
    expect(isBodyScan({ ...report, recordedOn: '2024-04-31' })).toBe(false);
    expect(isBodyScan({ ...report, text: 'x'.repeat(MAX_BODY_SCAN_TEXT_LENGTH + 1) })).toBe(false);
    expect(isBodyScan({ ...report, targets: { caloriesKcal: 2000 } })).toBe(false);
    expect(isBodyScan({ ...report, token: 'private-connection' })).toBe(false);
    expect(isBodyScanCollection([report, report])).toBe(false);
    const file = { id: 'shared-file', name: 'report.pdf', mimeType: 'application/pdf', size: 100 };
    expect(
      isBodyScanCollection([
        { ...report, file },
        { ...report, id: 'two', file },
      ]),
    ).toBe(false);
    expect(
      isBodyScanCollection(
        Array.from({ length: MAX_BODY_SCANS + 1 }, (_, index) => ({ ...report, id: `${index}` })),
      ),
    ).toBe(false);
  });

  it('copies the metadata and confirmed targets into credential-free kitchen backups', () => {
    const original: BodyScan = {
      ...report,
      file: { id: 'file-one', name: 'report.pdf', mimeType: 'application/pdf', size: 100 },
      targets: { caloriesKcal: 2000, proteinGrams: 100, carbsGrams: null, fatGrams: null },
    };
    const state: InventoryState = { products: [], batches: [], tools: [], bodyScans: [original] };
    expect(isInventoryState(state)).toBe(true);
    const copied = buildInventoryBackup(state).inventory.bodyScans![0];
    expect(copied).toEqual(original);
    expect(copied).not.toBe(original);
    expect(copied.file).not.toBe(original.file);
    expect(copied.targets).not.toBe(original.targets);
    expect(copyBodyScan(report)).toEqual(report);
    expect(isInventoryState({ ...state, bodyScans: [{ ...original, text: undefined }] })).toBe(
      false,
    );
  });
});
