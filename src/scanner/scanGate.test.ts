import { describe, expect, it } from 'vitest';
import { ScanGate } from './scanGate';

describe('a physical package scan', () => {
  it('counts one package even when a camera repeatedly decodes its label', () => {
    const gate = new ScanGate();
    let packages = 0;
    for (let frame = 0; frame < 100; frame++) {
      if (gate.accept()) packages++;
    }
    expect(packages).toBe(1);
  });

  it('counts identical packages only after the user starts each next scan', () => {
    const gate = new ScanGate();
    expect(gate.accept()).toBe(true);
    expect(gate.accept()).toBe(false);
    gate.rearm();
    expect(gate.accept()).toBe(true);
    expect(gate.accept()).toBe(false);
    gate.rearm();
    expect(gate.accept()).toBe(true);
  });
});
