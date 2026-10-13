import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractGeminiNutrition } from '../ai/client';
import { NutritionTargetsEditor } from './NutritionTargetsEditor';

vi.mock('../ai/client', () => ({
  readGeminiConnection: () => ({ url: 'https://mise.example.workers.dev', token: 'test' }),
  extractGeminiNutrition: vi.fn(),
  fileToGeminiMedia: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('reviewed daily nutrition targets', () => {
  it('extracts explicit targets for review without saving the report or applying targets automatically', async () => {
    const user = userEvent.setup();
    const targets = { caloriesKcal: 2200, proteinGrams: 120, carbsGrams: null, fatGrams: null };
    vi.mocked(extractGeminiNutrition).mockResolvedValue({
      targets,
      sourceText: 'Daily recommended intake: 2200 kcal, 120 g protein.',
      warnings: ['Carbohydrate and fat targets were not listed.'],
    });
    const save = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn();
    render(<NutritionTargetsEditor onSave={save} onClose={close} onConfigure={vi.fn()} />);
    await user.click(screen.getByText('Read targets from text or a report picture'));
    await user.type(
      screen.getByLabelText('Recommended targets or report text'),
      'Recommended daily targets: 2200 kcal, 120 g protein',
    );
    await user.click(screen.getByRole('button', { name: 'Extract for review' }));
    expect(await screen.findByText('Carbohydrate and fat targets were not listed.')).toBeVisible();
    expect(screen.getByLabelText(/Calories per day/)).toHaveValue(2200);
    expect(screen.getByLabelText(/Carbohydrates per day/)).toHaveValue(null);
    expect(save).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Save reviewed targets' }));
    expect(save).toHaveBeenCalledWith(targets);
    expect(Object.keys(save.mock.calls[0][0])).toHaveLength(4);
    expect(close).toHaveBeenCalledOnce();
  });
  it('keeps manual entry available after extraction fails and preserves unknown values', async () => {
    const user = userEvent.setup();
    vi.mocked(extractGeminiNutrition).mockRejectedValue(new Error('Free allowance reached.'));
    const save = vi.fn().mockResolvedValue(undefined);
    render(<NutritionTargetsEditor onSave={save} onClose={vi.fn()} onConfigure={vi.fn()} />);
    await user.click(screen.getByText('Read targets from text or a report picture'));
    await user.type(screen.getByLabelText('Recommended targets or report text'), 'Report');
    await user.click(screen.getByRole('button', { name: 'Extract for review' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Free allowance reached.');
    await user.type(screen.getByLabelText(/Protein per day/), '100');
    await user.click(screen.getByRole('button', { name: 'Save reviewed targets' }));
    expect(save).toHaveBeenCalledWith({
      caloriesKcal: null,
      proteinGrams: 100,
      carbsGrams: null,
      fatGrams: null,
    });
  });
});
