import { describe, expect, it } from 'vitest';
import { bodyScanContext } from './context';
import type { BodyScan } from './types';

const first: BodyScan = {
  id: 'report-one',
  name: 'Reviewed report',
  recordedOn: '2026-01-10',
  text: 'Selected, user-reviewed report information.',
  file: {
    id: 'private-file-id',
    name: 'private-original.pdf',
    mimeType: 'application/pdf',
    size: 100,
  },
};
const second: BodyScan = {
  id: 'report-two',
  name: 'Other report',
  recordedOn: null,
  text: 'Unselected report information must stay on this device.',
};

describe('explicit body scan context', () => {
  it('keeps every report private until explicitly selected', () => {
    expect(bodyScanContext([first, second], [])).toBe('');
    expect(bodyScanContext([{ ...first, text: '' }], [])).toBe('');
  });

  it('sends only selected reviewed text and dates, never the original file', () => {
    const context = bodyScanContext([first, second], [first.id]);
    expect(context).toContain(first.name);
    expect(context).toContain(first.recordedOn);
    expect(context).toContain(first.text);
    expect(context).not.toContain(second.text);
    expect(context).not.toContain(first.file!.id);
    expect(context).not.toContain(first.file!.name);
    expect(context).not.toContain(first.file!.mimeType);
  });

  it('ignores deleted selections and deduplicates a selected report', () => {
    const context = bodyScanContext([first], [first.id, first.id, 'deleted-report']);
    expect(context.match(/Selected, user-reviewed/g)).toHaveLength(1);
    expect(context).not.toContain('deleted-report');
    expect(bodyScanContext([], [first.id])).toBe('');
  });

  it('labels recorded recommendations without making them active daily goals', () => {
    const context = bodyScanContext(
      [
        {
          ...first,
          targets: { caloriesKcal: 2200, proteinGrams: 110, carbsGrams: null, fatGrams: null },
        },
      ],
      [first.id],
    );
    expect(context).toContain('Report recommendations: 2200 kcal · 110 g protein');
    expect(context).toContain('not automatically adopted daily goals');
    expect(context).not.toContain('null');
    expect(
      bodyScanContext(
        [
          {
            ...first,
            targets: { caloriesKcal: null, proteinGrams: null, carbsGrams: null, fatGrams: null },
          },
        ],
        [first.id],
      ),
    ).not.toContain('Report recommendations');
  });

  it('requires reviewed text and refuses oversized combinations without truncating reports', () => {
    expect(() => bodyScanContext([{ ...first, text: '' }], [first.id])).toThrow('Read or enter');
    const reports = [
      { ...first, text: 'a'.repeat(12_000) },
      { ...second, text: 'b'.repeat(12_000) },
    ];
    expect(() =>
      bodyScanContext(
        reports,
        reports.map((report) => report.id),
      ),
    ).toThrow('too long');
    expect(() => bodyScanContext([{ ...first, text: 'a'.repeat(24_000) }], [first.id])).toThrow(
      'Shorten its report text',
    );
  });
});
