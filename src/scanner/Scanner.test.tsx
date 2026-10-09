import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Scanner } from './Scanner';

const decoder = vi.hoisted(() => ({
  callback: null as
    ((result?: { getText: () => string; getBarcodeFormat: () => number }) => void) | null,
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
}));

describe('grocery scanner interaction', () => {
  beforeEach(() => {
    decoder.callback = null;
    decoder.stop.mockClear();
    vi.stubGlobal('isSecureContext', true);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('counts each intentional package once and releases the camera on exit', async () => {
    const stopTrack = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const add = vi.fn().mockResolvedValue(undefined);
    const view = render(<Scanner onAdd={add} onClose={() => undefined} />);
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
});
