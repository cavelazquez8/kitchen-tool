import { describe, expect, it, vi } from 'vitest';
import { readBodyScanFile, validateBodyScanFile } from './files';
import { MAX_BODY_SCAN_FILE_BYTES } from './types';

describe('body scan original validation', () => {
  it('accepts actual PDF and supported image signatures, including untyped phone files', async () => {
    await expect(
      validateBodyScanFile(new Blob(['%PDF-1.7\nExample report'], { type: 'application/pdf' })),
    ).resolves.toBe('application/pdf');
    await expect(
      validateBodyScanFile(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])])),
    ).resolves.toBe('image/jpeg');
    await expect(
      validateBodyScanFile(new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])])),
    ).resolves.toBe('image/png');
    await expect(validateBodyScanFile(new Blob(['RIFF1234WEBP']))).resolves.toBe('image/webp');
  });

  it('rejects HTML renamed as PDF and contradictory MIME declarations', async () => {
    await expect(
      validateBodyScanFile(new Blob(['<html>Example</html>'], { type: 'application/pdf' })),
    ).rejects.toThrow('Choose a PDF');
    await expect(
      validateBodyScanFile(new Blob(['%PDF-1.7'], { type: 'image/jpeg' })),
    ).rejects.toThrow('does not match');
  });

  it('rejects empty and oversized originals before reading them', async () => {
    await expect(validateBodyScanFile(new Blob())).rejects.toThrow('empty');
    const oversized = new Blob([new Uint8Array(MAX_BODY_SCAN_FILE_BYTES + 1)]);
    await expect(validateBodyScanFile(oversized)).rejects.toThrow('smaller than 4 MB');
  });

  it('reports unavailable browser storage without pretending the original was saved', async () => {
    vi.stubGlobal('indexedDB', undefined);
    try {
      await expect(readBodyScanFile('missing')).rejects.toThrow('Allow site storage');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
