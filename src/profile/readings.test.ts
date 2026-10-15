import { describe, expect, it } from 'vitest';
import { readingsFromReportText } from './readings';
import { bodyScanContext } from './context';
import { copyBodyScan, isBodyScan, type BodyScan } from './types';
import { buildInventoryBackup } from '../lib/backup';

describe('reviewed body scan fields', () => {
  it('copies labelled measurements and explicitly recommended ranges without calculating intake', () => {
    expect(
      readingsFromReportText(
        'Weight: 80 kg\nBMR: 1,750 kcal\nRecommended daily calories: 2,000–2,200 kcal\nProtein: 15 kg\nRecommended intake:\nProtein: 120–140 g',
      ),
    ).toEqual([
      { label: 'Weight', value: '80 kg', kind: 'measurement' },
      { label: 'BMR', value: '1,750 kcal', kind: 'measurement' },
      { label: 'Recommended daily calories', value: '2,000–2,200 kcal', kind: 'recommendation' },
      { label: 'Protein', value: '120–140 g', kind: 'recommendation' },
    ]);
    expect(
      readingsFromReportText('Calories: 2,000 kcal\nBMI: unknown\nTry eating more vegetables.'),
    ).toEqual([]);
  });

  it('sends selected structured fields instead of repeating the entire OCR report', () => {
    const scan: BodyScan = {
      id: 'scan',
      name: 'Reviewed scan',
      recordedOn: null,
      text: 'A long private report with unrelated notes.',
      readings: [
        { label: 'Body fat', value: '20%', kind: 'measurement' },
        { label: 'Calories', value: '2,000–2,200 kcal', kind: 'recommendation' },
      ],
    };
    const context = bodyScanContext([scan], ['scan']);
    expect(context).toContain('Measurement — Body fat: 20%');
    expect(context).toContain('Report recommendation — Calories: 2,000–2,200 kcal');
    expect(context).toContain('not dietary goals');
    expect(context).not.toContain(scan.text);
    expect(bodyScanContext([scan], [])).toBe('');
  });

  it('validates fields and keeps them through backups, including field-only manual reports', () => {
    const scan: BodyScan = {
      id: 'scan',
      name: 'Manual report',
      recordedOn: null,
      text: '',
      readings: [{ label: 'Weight', value: '80 kg', kind: 'measurement' }],
    };
    expect(isBodyScan(scan)).toBe(true);
    expect(isBodyScan({ ...scan, readings: [{ ...scan.readings![0], value: '' }] })).toBe(false);
    expect(isBodyScan({ ...scan, readings: [{ ...scan.readings![0], token: 'connection' }] })).toBe(
      false,
    );
    const copied = buildInventoryBackup({ products: [], batches: [], tools: [], bodyScans: [scan] })
      .inventory.bodyScans![0];
    expect(copied).toEqual(scan);
    expect(copied.readings).not.toBe(scan.readings);
    expect(copyBodyScan(scan).readings![0]).not.toBe(scan.readings![0]);
    expect(bodyScanContext([scan], ['scan'])).toContain('80 kg');
  });
});
