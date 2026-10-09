import { describe, expect, it } from 'vitest';
import { escapeMarkdownCell, generateMarkdown } from './export';
import { type InventoryState, createEmptyInventory } from './types';

function fixture(): InventoryState {
  return {
    products: [
      { id: 'rice', name: 'Rice | brown\norganic', brand: 'A&B', isStaple: true },
      { id: 'carrot', name: 'Carrots', isStaple: false },
    ],
    batches: [
      {
        id: 'rice-new',
        productId: 'rice',
        location: 'pantry',
        quantity: 2,
        unit: 'lb',
        purchasedOn: '2026-10-08',
        expiresOn: null,
        stapleStatus: 'low',
      },
      {
        id: 'carrot-1',
        productId: 'carrot',
        location: 'fridge',
        quantity: null,
        unit: '',
        purchasedOn: '2026-10-07',
        expiresOn: '2026-10-14',
      },
      {
        id: 'rice-old',
        productId: 'rice',
        location: 'pantry',
        quantity: 1,
        unit: 'lb',
        purchasedOn: '2026-10-01',
        expiresOn: '2027-01-01',
        stapleStatus: 'stocked',
      },
    ],
    tools: [
      { id: 'pot', name: 'Pot' },
      { id: 'blender', name: 'Blender' },
    ],
  };
}

describe('inventory Markdown', () => {
  it('includes preserved batches, explicit unknowns, staple status, and tools', () => {
    const markdown = generateMarkdown(fixture());
    expect(markdown).toContain('## Fridge');
    expect(markdown).toContain(
      '| Carrots | Unspecified | Quantity unknown | 2026-10-07 | 2026-10-14 | Available |',
    );
    expect(markdown).toContain(
      '| Rice \\| brown<br>organic | A&amp;B | 1 lb | 2026-10-01 | 2027-01-01 | stocked |',
    );
    expect(markdown).toContain(
      '| Rice \\| brown<br>organic | A&amp;B | 2 lb | 2026-10-08 | Unknown | low |',
    );
    expect(markdown.indexOf('## Fridge')).toBeLessThan(markdown.indexOf('## Pantry'));
    expect(markdown.indexOf('| Blender |')).toBeLessThan(markdown.indexOf('| Pot |'));
    expect(markdown).toMatch(/\n$/);
  });

  it('produces stable output regardless of input record order', () => {
    const original = fixture();
    expect(
      generateMarkdown({
        products: [...original.products].reverse(),
        batches: [...original.batches].reverse(),
        tools: [...original.tools].reverse(),
      }),
    ).toBe(generateMarkdown(original));
  });

  it('exports selected products or batches without including other groceries', () => {
    const markdown = generateMarkdown(fixture(), { batchIds: ['rice-new'], includeTools: false });
    expect(markdown).toContain('2026-10-08');
    expect(markdown).not.toContain('2026-10-01');
    expect(markdown).not.toContain('Carrots');
    expect(markdown).not.toContain('Kitchen tools');
    const combined = generateMarkdown(fixture(), {
      productIds: ['carrot'],
      batchIds: ['rice-old'],
    });
    expect(combined).toContain('Carrots');
    expect(combined).toContain('2026-10-01');
    expect(combined).not.toContain('2026-10-08');
  });

  it('treats an empty selection as empty rather than exporting everything', () => {
    const markdown = generateMarkdown(fixture(), { productIds: [], includeTools: false });
    expect(markdown).toContain('No food items recorded.');
    expect(markdown).not.toContain('Carrots');
  });

  it('keeps zero amounts explicitly empty and does not invent data', () => {
    const state = fixture();
    state.batches = [{ ...state.batches[1], quantity: 0, unit: 'items', expiresOn: null }];
    const markdown = generateMarkdown(state);
    expect(markdown).toContain(
      '| Carrots | Unspecified | 0 items | 2026-10-07 | Unknown | Empty |',
    );
  });

  it('never claims a known zero-quantity staple is available', () => {
    const state = fixture();
    state.batches = [{ ...state.batches[0], quantity: 0, stapleStatus: 'stocked' }];
    expect(generateMarkdown(state)).toContain(
      '| Rice \\| brown<br>organic | A&amp;B | 0 lb | 2026-10-08 | Unknown | Empty |',
    );
  });

  it('escapes cell delimiters, newlines, and HTML while preserving one table row', () => {
    expect(escapeMarkdownCell('a\\b|c\r\nd<e>')).toBe('a\\\\b\\|c<br>d&lt;e&gt;');
  });

  it('exports a truthful empty inventory without demonstration groceries', () => {
    const markdown = generateMarkdown(createEmptyInventory());
    expect(markdown).toContain('No food items recorded.');
    expect(markdown).toContain('No kitchen tools recorded.');
    expect(markdown).not.toContain('Carrots');
  });
});
