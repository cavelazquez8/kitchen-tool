import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@zxing/library';
import { AUTO_NEXT_PREFERENCE_KEY, Scanner } from './Scanner';

const decoder = vi.hoisted(() => ({
  callback: null as
    | ((
        result?: { getText: () => string; getBarcodeFormat: () => number },
        error?: unknown,
      ) => void)
    | null,
  stop: vi.fn(),
}));

vi.mock('@zxing/browser', () => ({
  BrowserMultiFormatReader: class {
    possibleFormats: number[] = [];

    decodeFromStream(
      stream: MediaStream,
      video: HTMLVideoElement,
      callback: typeof decoder.callback,
    ) {
      void stream;
      void video;
      decoder.callback = callback;
      return Promise.resolve({ stop: decoder.stop });
    }
  },
}));

vi.mock('@zxing/library', () => ({
  BarcodeFormat: { EAN_13: 7, EAN_8: 6, UPC_A: 14, UPC_E: 15 },
  NotFoundException: class extends Error {},
}));

describe('grocery scanner interaction', () => {
  beforeEach(() => {
    decoder.callback = null;
    decoder.stop.mockClear();
    localStorage.clear();
    vi.stubGlobal('isSecureContext', true);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('counts each intentional package once and releases the camera on exit', async () => {
    const stopTrack = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const add = vi.fn().mockResolvedValue(undefined);
    const view = render(<Scanner onAdd={add} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('switch', { name: /Automatically scan next item/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Start camera' }));
    await waitFor(() => expect(screen.getByText('Ready to scan')).toBeInTheDocument());
    expect(getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: false,
        video: expect.objectContaining({ facingMode: { ideal: 'environment' } }),
      }),
    );

    const packageResult = { getText: () => '034000470693', getBarcodeFormat: () => 14 };
    await act(async () => {
      for (let frame = 0; frame < 20; frame++) decoder.callback?.(packageResult);
    });
    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith('0034000470693');

    fireEvent.click(screen.getByRole('button', { name: 'Scan next package' }));
    await act(async () => decoder.callback?.(packageResult));
    expect(add).toHaveBeenCalledTimes(2);

    view.unmount();
    expect(decoder.stop).toHaveBeenCalledTimes(1);
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });

  it('keeps typed barcode entry available after camera permission is denied', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockRejectedValue(new DOMException('Denied', 'NotAllowedError')),
      },
    });
    const add = vi.fn().mockResolvedValue(undefined);
    render(<Scanner onAdd={add} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start camera' }));
    await screen.findByText(/Camera access is off/);
    fireEvent.change(screen.getByRole('textbox', { name: 'Or enter a barcode' }), {
      target: { value: '034000470693' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(add).toHaveBeenCalledWith('0034000470693'));
  });

  it('releases a camera permission response that arrives after the scanner has closed', async () => {
    const stopTrack = vi.fn();
    const lateStream = { getTracks: () => [{ stop: stopTrack }] };
    let resolveStream: (stream: typeof lateStream) => void = () => undefined;
    const getUserMedia = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStream = resolve;
        }),
    );
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const view = render(
      <Scanner onAdd={vi.fn().mockResolvedValue(undefined)} onClose={() => undefined} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start camera' }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => resolveStream(lateStream));
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(decoder.callback).toBeNull();
  });

  it('does not add an incomplete barcode and explains how to fix it', () => {
    const add = vi.fn().mockResolvedValue(undefined);
    render(<Scanner onAdd={add} onClose={() => undefined} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Or enter a barcode' }), {
      target: { value: '123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('alert')).toHaveTextContent('complete UPC or EAN');
    expect(add).not.toHaveBeenCalled();
  });

  it('retains the typed code and offers retry when adding a package fails', async () => {
    const add = vi.fn().mockRejectedValue(new Error('The package could not be saved. Try again.'));
    render(<Scanner onAdd={add} onClose={() => undefined} />);
    const input = screen.getByRole('textbox', { name: 'Or enter a barcode' });
    fireEvent.change(input, { target: { value: '034000470693' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Try again');
    expect(input).toHaveValue('034000470693');
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled();
  });

  it('defaults to automatic scanning and persists the user’s preference across openings', () => {
    const view = render(
      <Scanner onAdd={vi.fn().mockResolvedValue(undefined)} onClose={() => undefined} />,
    );
    const toggle = screen.getByRole('switch', { name: /Automatically scan next item/ });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(localStorage.getItem(AUTO_NEXT_PREFERENCE_KEY)).toBe('false');
    view.unmount();
    render(<Scanner onAdd={vi.fn().mockResolvedValue(undefined)} onClose={() => undefined} />);
    expect(screen.getByRole('switch', { name: /Automatically scan next item/ })).not.toBeChecked();
  });

  it('automatically scans another identical package only after sustained no-barcode observations', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }) },
    });
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const add = vi.fn().mockResolvedValue(true);
    render(<Scanner onAdd={add} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start camera' }));
    await screen.findByText('Ready to scan');
    const item = { getText: () => '034000470693', getBarcodeFormat: () => 14 };
    await act(async () => decoder.callback?.(item));
    expect(add).toHaveBeenCalledTimes(1);
    now = 20_000;
    await act(async () => decoder.callback?.(item));
    expect(add).toHaveBeenCalledTimes(1);
    await act(async () => {
      for (const next of [20_350, 20_700, 21_050, 21_750]) {
        now = next;
        decoder.callback?.(undefined, new NotFoundException());
      }
    });
    expect(screen.getByText('Ready to scan')).toBeInTheDocument();
    await act(async () => decoder.callback?.(item));
    expect(add).toHaveBeenCalledTimes(2);
  });

  it('ignores frames while awaiting parent review, then safely resumes for a different barcode', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }) },
    });
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    let finishReview: (added: boolean) => void = () => undefined;
    const add = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            finishReview = resolve;
          }),
      )
      .mockResolvedValue(true);
    render(<Scanner onAdd={add} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start camera' }));
    await screen.findByText('Ready to scan');
    const first = { getText: () => '034000470693', getBarcodeFormat: () => 14 };
    const second = { getText: () => '012345678905', getBarcodeFormat: () => 14 };
    await act(async () => decoder.callback?.(first));
    expect(screen.getByText('Reviewing item…')).toBeInTheDocument();
    await act(async () => {
      for (const next of [300, 600, 900, 1_500]) {
        now = next;
        decoder.callback?.(undefined, new NotFoundException());
      }
      decoder.callback?.(second);
    });
    expect(add).toHaveBeenCalledTimes(1);
    await act(async () => finishReview(true));
    await act(async () => decoder.callback?.(first));
    expect(add).toHaveBeenCalledTimes(1);
    await act(async () => {
      now = 2_000;
      decoder.callback?.(second);
      now = 2_350;
      decoder.callback?.(second);
    });
    expect(add).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenLastCalledWith('0012345678905');
  });

  it('does not treat checksum errors as proof that the package left the frame', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }) },
    });
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const add = vi.fn().mockResolvedValue(true);
    render(<Scanner onAdd={add} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start camera' }));
    await screen.findByText('Ready to scan');
    const item = { getText: () => '034000470693', getBarcodeFormat: () => 14 };
    await act(async () => decoder.callback?.(item));
    await act(async () => {
      for (const next of [300, 600, 900, 1_500, 2_000, 3_000]) {
        now = next;
        decoder.callback?.(undefined, new Error('Checksum failed'));
      }
      decoder.callback?.(item);
    });
    expect(add).toHaveBeenCalledTimes(1);
  });

  it('shows cancellation without claiming the item was added', async () => {
    render(<Scanner onAdd={vi.fn().mockResolvedValue(false)} onClose={() => undefined} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Or enter a barcode' }), {
      target: { value: '034000470693' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(
      await screen.findByText('Item not added. You can scan again when ready.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Or enter a barcode' })).toHaveValue('034000470693');
  });
});
