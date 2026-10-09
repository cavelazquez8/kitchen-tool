import { daysUntil } from '../domain/inventory';
import type { Batch, InventoryGroup } from '../domain/types';

export function dateLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
    new Date(`${value}T12:00:00`),
  );
}

export function expiryLabel(date: string | null): string {
  if (!date) return 'No date';
  const days = daysUntil(date);
  if (days < 0) return `${Math.abs(days)}d past date`;
  if (days === 0) return 'Dated today';
  if (days === 1) return 'Dated tomorrow';
  return dateLabel(date);
}

export function groupExpiry(group: InventoryGroup): string | null {
  return (
    group.batches
      .filter((batch) => batch.quantity !== 0 && batch.stapleStatus !== 'empty')
      .map((batch) => batch.expiresOn)
      .filter((date): date is string => !!date)
      .sort()[0] ?? null
  );
}

export function isSoon(batch: Batch): boolean {
  return (
    batch.quantity !== 0 &&
    batch.stapleStatus !== 'empty' &&
    !!batch.expiresOn &&
    daysUntil(batch.expiresOn) <= 3
  );
}

export function stapleCaption(group: InventoryGroup): string {
  const available = group.batches.filter(
    (batch) => batch.quantity !== 0 && batch.stapleStatus !== 'empty',
  );
  if (available.some((batch) => !batch.stapleStatus || batch.stapleStatus === 'stocked')) {
    return 'Assume enough';
  }
  return available.some((batch) => batch.stapleStatus === 'low') ? 'Running low' : 'Empty';
}

export function foodIcon(name: string): string {
  if (/milk|cream|yogurt|cheese|butter/i.test(name)) return '🥛';
  if (/egg/i.test(name)) return '🥚';
  if (/chicken|turkey/i.test(name)) return '🍗';
  if (/beef|steak|pork|meat/i.test(name)) return '🥩';
  if (/carrot/i.test(name)) return '🥕';
  if (/apple|pear|fruit/i.test(name)) return '🍎';
  if (/lemon|lime|orange/i.test(name)) return '🍋';
  if (/rice|pasta|noodle/i.test(name)) return '🍚';
  if (/bread|flour|bagel/i.test(name)) return '🍞';
  if (/fish|salmon|tuna/i.test(name)) return '🐟';
  if (/tomato/i.test(name)) return '🍅';
  if (/potato/i.test(name)) return '🥔';
  return '🌿';
}
