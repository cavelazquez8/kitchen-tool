import type { BodyScan } from './types';
import { NUTRITION_KEYS } from '../nutrition/types';
import { formatReportReadings, hasReviewedReport } from './readings';

function reportRecommendations(scan: BodyScan): string {
  if (!scan.targets || !NUTRITION_KEYS.some((key) => scan.targets![key] !== null)) return '';
  const values = [
    scan.targets.caloriesKcal === null ? '' : `${scan.targets.caloriesKcal} kcal`,
    scan.targets.proteinGrams === null ? '' : `${scan.targets.proteinGrams} g protein`,
    scan.targets.carbsGrams === null ? '' : `${scan.targets.carbsGrams} g carbs`,
    scan.targets.fatGrams === null ? '' : `${scan.targets.fatGrams} g fat`,
  ]
    .filter(Boolean)
    .join(' · ');
  return `\nReport recommendations: ${values}. These are this report's recorded recommendations, not automatically adopted daily goals.`;
}

/** Only explicit selections enter a request; originals are never attached to chat. */
export function bodyScanContext(
  scans: readonly BodyScan[],
  selectedIds: readonly string[],
): string {
  const selected = scans.filter((scan) => selectedIds.includes(scan.id));
  if (selected.some((scan) => !hasReviewedReport(scan)))
    throw new Error('Read or enter report text before adding this body scan to Gemini.');
  const text = selected
    .map(
      (scan) =>
        `Body scan: ${scan.name}\nRecorded: ${scan.recordedOn ?? 'Date not recorded'}\n${scan.readings?.length ? `${formatReportReadings(scan.readings)}\nThese are user-reviewed report values. Measurements are not dietary goals; recorded recommendations have not automatically been adopted as daily goals.` : scan.text}${reportRecommendations(scan)}`,
    )
    .join('\n\n');
  if (text.length > 24_000)
    throw new Error(
      selected.length === 1
        ? 'This report is too long to attach. Shorten its report text in your profile, then try again.'
        : 'These reports are too long to send together. Remove a body scan from Gemini context.',
    );
  return text;
}
