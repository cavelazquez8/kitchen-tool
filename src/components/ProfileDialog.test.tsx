import { useState } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractGeminiBodyScan, fileToBodyScanMedia, readGeminiConnection } from '../ai/client';
import type { InventoryState } from '../domain/types';
import { deleteBodyScanFile, saveBodyScanFile, validateBodyScanFile } from '../profile/files';
import type { BodyScan } from '../profile/types';
import { ProfileDialog } from './ProfileDialog';

vi.mock('../ai/client', () => ({
  readGeminiConnection: vi.fn(),
  extractGeminiBodyScan: vi.fn(),
  fileToBodyScanMedia: vi.fn(),
  extractGeminiNutrition: vi.fn(),
  fileToGeminiMedia: vi.fn(),
}));
vi.mock('../profile/files', () => ({
  saveBodyScanFile: vi.fn(),
  readBodyScanFile: vi.fn(),
  deleteBodyScanFile: vi.fn(),
  validateBodyScanFile: vi.fn(),
}));

const blank: InventoryState = { products: [], batches: [], tools: [] };
const original = {
  id: 'file-1',
  name: 'scan.pdf',
  mimeType: 'application/pdf' as const,
  size: 100,
};
const scan: BodyScan = {
  id: 'scan-1',
  name: 'October report',
  recordedOn: '2026-10-01',
  text: 'Synthetic report: body composition readings.',
  file: original,
};
const toast = vi.fn();
const attach = vi.fn();
const configure = vi.fn();

function Harness({ initial = blank }: { initial?: InventoryState }) {
  const [inventory, setInventory] = useState(initial);
  return (
    <ProfileDialog
      inventory={inventory}
      update={async (change) => {
        setInventory((current) => change(current));
      }}
      onClose={vi.fn()}
      onToast={toast}
      onAttach={attach}
      onConfigure={configure}
    />
  );
}

beforeEach(() => {
  vi.mocked(readGeminiConnection).mockReturnValue({
    url: 'https://mise.example.workers.dev',
    token: 'test',
  });
  vi.mocked(validateBodyScanFile).mockResolvedValue('application/pdf');
  vi.mocked(saveBodyScanFile).mockResolvedValue(original);
  vi.mocked(deleteBodyScanFile).mockResolvedValue(undefined);
  vi.mocked(fileToBodyScanMedia).mockResolvedValue({
    mimeType: 'application/pdf',
    data: 'JVBERi0=',
  });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('saved body scans', () => {
  it('autofills editable report fields and keeps reported ranges separate from approved goals', async () => {
    const user = userEvent.setup();
    const update = vi.fn().mockResolvedValue(undefined);
    vi.mocked(extractGeminiBodyScan).mockResolvedValue({
      text: 'Body fat: 20%. Recommended calories: 2,000–2,200 kcal.',
      recordedOn: null,
      targets: { caloriesKcal: null, proteinGrams: null, carbsGrams: null, fatGrams: null },
      warnings: [],
      readings: [
        { label: 'Body fat', value: '20%', kind: 'measurement' },
        { label: 'Calories', value: '2,000–2,200 kcal', kind: 'recommendation' },
      ],
    });
    render(
      <ProfileDialog
        inventory={blank}
        update={update}
        onClose={vi.fn()}
        onToast={toast}
        onAttach={attach}
        onConfigure={configure}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Add scan' }));
    await user.type(screen.getByLabelText('Report name'), 'Reviewed example');
    await user.type(screen.getByLabelText(/Report text/), 'An example report.');
    await user.click(screen.getByRole('button', { name: 'Read with Gemini' }));
    const value = await screen.findByLabelText('Report value 1');
    expect(value).toHaveValue('20%');
    expect(screen.getByLabelText('Report value 2')).toHaveValue('2,000–2,200 kcal');
    await user.clear(value);
    await user.type(value, '20.5%');
    await user.click(screen.getByRole('button', { name: 'Save report' }));
    const saved = update.mock.calls[0][0](blank) as InventoryState;
    expect(saved.bodyScans?.[0].readings?.[0].value).toBe('20.5%');
    expect(saved.bodyScans?.[0].readings?.[1].value).toBe('2,000–2,200 kcal');
    expect(saved.nutritionTargets).toBeUndefined();
  });
  it('saves an original without sending it to Gemini and requires text before attaching it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Add scan' }));
    await user.upload(
      screen.getByLabelText('Body scan file'),
      new File(['%PDF-1.7 synthetic'], 'scan.pdf', { type: 'application/pdf' }),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save report' })).toBeEnabled());
    expect(saveBodyScanFile).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Save report' }));
    expect(await screen.findByRole('button', { name: 'Add to Gemini' })).toBeDisabled();
    expect(extractGeminiBodyScan).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
    expect(saveBodyScanFile).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'View & edit' }));
    await user.type(
      screen.getByLabelText(/Report text/),
      'Reviewed readings from the saved report.',
    );
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await user.click(await screen.findByRole('button', { name: 'Add to Gemini' }));
    expect(attach).toHaveBeenCalledWith(expect.any(String));
    expect(saveBodyScanFile).toHaveBeenCalledOnce();
  });

  it('reads only on request, preserves ranges, and saves reports without applying nutrition goals', async () => {
    const user = userEvent.setup();
    const update = vi.fn().mockResolvedValue(undefined);
    vi.mocked(extractGeminiBodyScan).mockResolvedValue({
      text: 'Recommended energy: 2,000–2,200 kcal. Body readings as printed.',
      recordedOn: '2026-10-01',
      targets: { caloriesKcal: null, proteinGrams: null, carbsGrams: null, fatGrams: null },
      warnings: ['A recommended range was retained in the report text.'],
    });
    render(
      <ProfileDialog
        inventory={blank}
        update={update}
        onClose={vi.fn()}
        onToast={toast}
        onAttach={attach}
        onConfigure={configure}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Add scan' }));
    await user.type(screen.getByLabelText('Report name'), 'Synthetic report');
    await user.type(screen.getByLabelText(/Report text/), 'Recommended energy: 2,000–2,200 kcal.');
    expect(extractGeminiBodyScan).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Read with Gemini' }));
    expect(
      await screen.findByText('A recommended range was retained in the report text.'),
    ).toBeVisible();
    expect(screen.getByLabelText(/Report text/)).toHaveValue(
      'Recommended energy: 2,000–2,200 kcal. Body readings as printed.',
    );
    expect(update).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Save report' }));
    const next = update.mock.calls[0][0](blank) as InventoryState;
    expect(next.bodyScans?.[0].recordedOn).toBe('2026-10-01');
    expect(next.bodyScans?.[0].text).toContain('2,000–2,200');
    expect(next.nutritionTargets).toBeUndefined();
    expect(attach).not.toHaveBeenCalled();
  });

  it('rolls back a newly saved original when metadata cannot be saved', async () => {
    const user = userEvent.setup();
    render(
      <ProfileDialog
        inventory={blank}
        update={vi.fn().mockRejectedValue(new Error('Storage full.'))}
        onClose={vi.fn()}
        onToast={toast}
        onAttach={attach}
        onConfigure={configure}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Add scan' }));
    await user.upload(
      screen.getByLabelText('Body scan file'),
      new File(['%PDF-1.7 synthetic'], 'scan.pdf', { type: 'application/pdf' }),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save report' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Save report' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Storage full.');
    expect(deleteBodyScanFile).toHaveBeenCalledWith(original.id);
    expect(screen.getByRole('button', { name: 'Save report' })).toBeEnabled();
  });

  it('does not delete originals until report deletion succeeds, and clears stale targets on text edits', async () => {
    const user = userEvent.setup();
    const update = vi.fn().mockResolvedValue(undefined);
    const withTargets = {
      ...scan,
      targets: { caloriesKcal: 2200, proteinGrams: 100, carbsGrams: null, fatGrams: null },
    };
    render(
      <ProfileDialog
        inventory={{ ...blank, bodyScans: [withTargets] }}
        update={update}
        onClose={vi.fn()}
        onToast={toast}
        onAttach={attach}
        onConfigure={configure}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'View & edit' }));
    await user.type(screen.getByLabelText(/Report text/), ' Corrected report text.');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(
      (update.mock.calls[0][0]({ ...blank, bodyScans: [withTargets] }) as InventoryState)
        .bodyScans?.[0].targets,
    ).toBeUndefined();
    expect(deleteBodyScanFile).not.toHaveBeenCalled();
    update.mockRejectedValueOnce(new Error('Save failed.'));
    await user.click(screen.getByRole('button', { name: 'Delete October report' }));
    await user.click(screen.getByRole('button', { name: 'Delete report' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Save failed.');
    expect(deleteBodyScanFile).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Delete report' }));
    await waitFor(() => expect(deleteBodyScanFile).toHaveBeenCalledWith(original.id));
  });
});
