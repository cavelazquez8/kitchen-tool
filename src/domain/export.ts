import { compareNames, formatQuantity, groupInventory } from './inventory';
import { type InventoryState, LOCATION_LABELS, STORAGE_LOCATIONS } from './types';

export interface MarkdownExportOptions {
  /** If provided, include batches belonging to these products. */
  productIds?: readonly string[];
  /** Batch selections are combined with product selections. */
  batchIds?: readonly string[];
  includeTools?: boolean;
}

export function escapeMarkdownCell(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r\n|\r|\n/g, '<br>');
}

/** A deterministic inventory document: no guessed dates, amounts, or AI requests. */
export function generateMarkdown(
  state: InventoryState,
  options: MarkdownExportOptions = {},
): string {
  const selected = options.productIds !== undefined || options.batchIds !== undefined;
  const productIds = new Set(options.productIds ?? []);
  const batchIds = new Set(options.batchIds ?? []);
  const filtered: InventoryState = {
    ...state,
    batches: selected
      ? state.batches.filter((batch) => productIds.has(batch.productId) || batchIds.has(batch.id))
      : state.batches,
  };
  const groups = groupInventory(filtered);
  const lines = [
    '# Kitchen inventory',
    '',
    'Unknown quantities and dates are explicitly marked. Stocked staples are assumed available; low staples may need checking, and empty staples are unavailable.',
    '',
  ];
  if (!groups.length) lines.push('No food items recorded.', '');
  for (const location of STORAGE_LOCATIONS) {
    const located = groups.filter((group) => group.location === location);
    if (!located.length) continue;
    lines.push(
      `## ${LOCATION_LABELS[location]}`,
      '',
      '| Item | Brand | Quantity | Purchased | Expiration | Status |',
      '| --- | --- | --- | --- | --- | --- |',
    );
    for (const group of located) {
      for (const batch of group.batches) {
        const cells = [
          group.product.name,
          group.product.brand ?? 'Unspecified',
          formatQuantity(batch.quantity, batch.unit),
          batch.purchasedOn,
          batch.expiresOn ?? 'Unknown',
          batch.quantity === 0
            ? 'Empty'
            : group.product.isStaple
              ? (batch.stapleStatus ?? 'stocked')
              : 'Available',
        ];
        lines.push(`| ${cells.map(escapeMarkdownCell).join(' | ')} |`);
      }
    }
    lines.push('');
  }
  if (options.includeTools !== false) {
    lines.push('## Kitchen tools', '');
    const tools = [...state.tools].sort(
      (a, b) => compareNames(a.name, b.name) || a.id.localeCompare(b.id),
    );
    if (!tools.length) lines.push('No kitchen tools recorded.');
    else {
      lines.push('| Tool |', '| --- |');
      for (const tool of tools) lines.push(`| ${escapeMarkdownCell(tool.name)} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
