import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverGeminiModels, type GeminiConnection } from '../ai/client';
import { readModelPreferences, saveModelCatalog } from '../ai/modelPreferences';
import { GEMINI_PRICING_URL, type GeminiModelCatalog } from '../ai/models';
import { GeminiModelPicker } from './GeminiModelPicker';

vi.mock('../ai/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai/client')>()),
  discoverGeminiModels: vi.fn(),
}));

const connection: GeminiConnection = {
  url: 'https://mise.example.workers.dev',
  token: 'test_only_' + 'a'.repeat(40),
};

function catalog(): GeminiModelCatalog {
  return {
    models: [
      {
        id: 'gemini-4.0-flash',
        name: 'Gemini 4.0 Flash',
        description: 'New general-purpose model.',
        inputTokenLimit: 1_048_576,
        outputTokenLimit: 65_536,
        freeTier: 'verified',
      },
      {
        id: 'gemini-4.0-pro',
        name: 'Gemini 4.0 Pro',
        description: 'Paid model.',
        inputTokenLimit: null,
        outputTokenLimit: null,
        freeTier: 'unavailable',
      },
      {
        id: 'gemini-4.0-experimental',
        name: 'Gemini 4.0 Experimental',
        description: 'Pricing not confirmed.',
        inputTokenLimit: null,
        outputTokenLimit: null,
        freeTier: 'unknown',
      },
    ],
    checkedAt: new Date().toISOString(),
    pricingUrl: GEMINI_PRICING_URL,
    warnings: [],
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(discoverGeminiModels).mockReset();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('Gemini model discovery and review', () => {
  it('loads new models automatically but changes the draft only after an explicit free-tier review', async () => {
    const discovered = catalog();
    vi.mocked(discoverGeminiModels).mockResolvedValue(discovered);
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <GeminiModelPicker
        connection={connection}
        draft={connection}
        busy={false}
        onChange={onChange}
      />,
    );

    await screen.findByText(/Last checked/);
    expect(discoverGeminiModels).toHaveBeenCalledWith(
      connection,
      { refresh: false },
      expect.any(AbortSignal),
    );
    expect(onChange).not.toHaveBeenCalled();
    await user.click(screen.getByText('Models from Google'));
    await user.click(screen.getByRole('button', { name: 'Review Gemini 4.0 Flash' }));
    const review = screen.getByRole('dialog', { name: 'Enable Gemini 4.0 Flash?' });
    expect(within(review).getByRole('button', { name: 'Enable model' })).toBeDisabled();
    expect(within(review).getByRole('link', { name: /View Google’s pricing/ })).toHaveAttribute(
      'href',
      GEMINI_PRICING_URL,
    );
    await user.click(within(review).getByRole('checkbox', { name: /billing disabled/ }));
    await user.click(within(review).getByRole('button', { name: 'Enable model' }));

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith({
      ...connection,
      model: 'gemini-4.0-flash',
      modelReviewed: true,
    });
    expect(readModelPreferences(connection.url).reviewedIds).toEqual(['gemini-4.0-flash']);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps paid and unverified models disabled and excludes all unreviewed discoveries from the selector', async () => {
    saveModelCatalog(connection.url, catalog());
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <GeminiModelPicker
        connection={connection}
        draft={connection}
        busy={false}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByText('Models from Google'));
    const paid = screen.getByRole('heading', { name: 'Gemini 4.0 Pro' }).closest('article')!;
    const unknown = screen
      .getByRole('heading', { name: 'Gemini 4.0 Experimental' })
      .closest('article')!;
    expect(within(paid).getByText(/Requires a paid tier/)).toBeVisible();
    expect(within(unknown).getByText(/pricing could not be confirmed/)).toBeVisible();
    expect(within(paid).queryByRole('button')).not.toBeInTheDocument();
    expect(within(unknown).queryByRole('button')).not.toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'Gemini model' }));
    const options = screen.getByRole('listbox', { name: 'Gemini model options' });
    expect(within(options).getAllByRole('option')).toHaveLength(4);
    expect(within(options).getByRole('option', { name: 'Worker default' })).toBeVisible();
    expect(within(options).queryByRole('option', { name: /Gemini 4.0/ })).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(discoverGeminiModels).not.toHaveBeenCalled();
  });

  it('preserves an existing reviewed choice and built-in alternatives when discovery fails', async () => {
    vi.mocked(discoverGeminiModels).mockRejectedValue(
      new Error('Refresh unavailable. Your saved choice is unchanged.'),
    );
    const selected: GeminiConnection = {
      ...connection,
      model: 'gemini-4.0-flash',
      modelReviewed: true,
    };
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <GeminiModelPicker connection={selected} draft={selected} busy={false} onChange={onChange} />,
    );

    expect(
      await screen.findByText('Refresh unavailable. Your saved choice is unchanged.'),
    ).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Gemini model' })).toHaveTextContent(
      'gemini-4.0-flash · Saved selection',
    );
    await user.click(screen.getByRole('combobox', { name: 'Gemini model' }));
    const options = screen.getByRole('listbox', { name: 'Gemini model options' });
    expect(within(options).getByRole('option', { name: /Saved selection/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(within(options).getByRole('option', { name: /Gemini 3.5 Flash-Lite/ })).toBeVisible();
    expect(within(options).getByRole('option', { name: 'Worker default' })).toBeVisible();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('cancels requests when pairing changes or the picker closes and ignores late responses', async () => {
    const resolvers: ((value: GeminiModelCatalog) => void)[] = [];
    vi.mocked(discoverGeminiModels).mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    );
    const onChange = vi.fn();
    const { rerender, unmount } = render(
      <GeminiModelPicker
        connection={connection}
        draft={connection}
        busy={false}
        onChange={onChange}
      />,
    );
    await waitFor(() => expect(discoverGeminiModels).toHaveBeenCalledTimes(1));
    const oldSignal = vi.mocked(discoverGeminiModels).mock.calls[0][2]!;
    const other = { ...connection, url: 'https://other.example.workers.dev' };
    rerender(
      <GeminiModelPicker connection={other} draft={other} busy={false} onChange={onChange} />,
    );
    await waitFor(() => expect(discoverGeminiModels).toHaveBeenCalledTimes(2));
    expect(oldSignal.aborted).toBe(true);

    await act(async () => resolvers[0](catalog()));
    expect(screen.queryByText(/Last checked/)).not.toBeInTheDocument();
    expect(readModelPreferences(other.url).catalog).toBeNull();
    const currentSignal = vi.mocked(discoverGeminiModels).mock.calls[1][2]!;
    unmount();
    expect(currentSignal.aborted).toBe(true);
    await act(async () => resolvers[1](catalog()));
    expect(readModelPreferences(other.url).catalog).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reuses a fresh cached catalog but supports a deliberate refresh without changing the chosen model', async () => {
    saveModelCatalog(connection.url, catalog());
    const updated = { ...catalog(), warnings: ['Model availability has been refreshed.'] };
    vi.mocked(discoverGeminiModels).mockResolvedValue(updated);
    const selected: GeminiConnection = { ...connection, model: 'gemini-3.8-flash' };
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <GeminiModelPicker connection={selected} draft={selected} busy={false} onChange={onChange} />,
    );
    expect(discoverGeminiModels).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Refresh models' }));
    expect(await screen.findByText(updated.warnings[0])).toBeVisible();
    expect(discoverGeminiModels).toHaveBeenCalledWith(
      connection,
      { refresh: true },
      expect.any(AbortSignal),
    );
    expect(readModelPreferences(connection.url).catalog).toEqual(updated);
    expect(screen.getByRole('combobox', { name: 'Gemini model' })).toHaveTextContent(
      'Gemini 3.8 Flash',
    );
    expect(onChange).not.toHaveBeenCalled();
  });
});
