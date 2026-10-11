import { describe, expect, it } from 'vitest';
import { ScanGate } from './scanGate';

describe('a physical package scan', () => {
  it('counts one package even when the camera keeps decoding it for minutes', () => {
    const gate = new ScanGate();
    let packages = 0;
    for (let frame = 0; frame < 1_000; frame++) {
      if (gate.observe('item-a', frame * 350, true)) packages++;
    }
    expect(packages).toBe(1);
  });

  it('automatically allows the same barcode after sustained observed absence', () => {
    const gate = new ScanGate();
    expect(gate.observe('item-a', 0, true)).toBe(true);
    for (const now of [300, 600, 900, 1_500]) gate.observe(null, now, true);
    expect(gate.isArmed).toBe(true);
    expect(gate.observe('item-a', 1_750, true)).toBe(true);
    expect(gate.observe('item-a', 2_100, true)).toBe(false);
  });

  it('does not rearm from one delayed no-barcode frame or a brief decoding gap', () => {
    const gate = new ScanGate();
    gate.observe('item-a', 0, true);
    gate.observe(null, 10_000, true);
    expect(gate.isArmed).toBe(false);
    for (const now of [10_250, 10_500, 10_750]) gate.observe(null, now, true);
    expect(gate.isArmed).toBe(false);
    expect(gate.observe('item-a', 11_000, true)).toBe(false);
    for (const now of [11_250, 11_500, 11_750]) gate.observe(null, now, true);
    expect(gate.isArmed).toBe(false);
  });

  it('accepts a stable different barcode without requiring a blank view', () => {
    const gate = new ScanGate();
    gate.observe('item-a', 0, true);
    expect(gate.observe('item-b', 900, true)).toBe(false);
    expect(gate.observe('item-b', 1_250, true)).toBe(true);
    expect(gate.observe('item-b', 1_600, true)).toBe(false);
  });

  it('rejects isolated different barcodes and respects the capture cooldown', () => {
    const gate = new ScanGate();
    gate.observe('item-a', 0, true);
    expect(gate.observe('item-b', 100, true)).toBe(false);
    expect(gate.observe('item-b', 450, true)).toBe(false);
    expect(gate.observe('item-b', 900, true)).toBe(false);
    expect(gate.observe('item-a', 1_250, true)).toBe(false);
    expect(gate.observe('item-b', 1_600, true)).toBe(false);
    expect(gate.observe('item-c', 1_950, true)).toBe(false);
  });

  it('requires explicit rearming when automatic scanning is off', () => {
    const gate = new ScanGate();
    expect(gate.observe('item-a', 0, false)).toBe(true);
    for (const now of [300, 600, 900, 1_500]) gate.observe(null, now, false);
    expect(gate.observe('item-b', 2_000, false)).toBe(false);
    expect(gate.observe('item-b', 2_350, false)).toBe(false);
    gate.rearm();
    expect(gate.observe('item-a', 2_700, false)).toBe(true);
  });

  it('discards observations interrupted by review or toggling automatic scanning', () => {
    const gate = new ScanGate();
    gate.observe('item-a', 0, true);
    for (const now of [300, 600, 900]) gate.observe(null, now, true);
    gate.resetObservations();
    gate.observe(null, 10_000, true);
    expect(gate.isArmed).toBe(false);
    expect(gate.observe('item-a', 10_350, true)).toBe(false);
  });

  it('explicit typed entry locks the camera against decoding that same item again', () => {
    const gate = new ScanGate();
    gate.capture('item-a', 0);
    expect(gate.observe('item-a', 20_000, true)).toBe(false);
    gate.rearm();
    expect(gate.observe('item-a', 20_350, true)).toBe(true);
  });
});
