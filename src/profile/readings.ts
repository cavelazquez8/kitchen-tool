import type { BodyScan, BodyScanReading } from './types';

const knownMeasurement =
  /^(?:(?:total\s+)?(?:body\s+)?weight|height|age|biological age|bmi|body mass index|(?:total\s+)?body fat(?: percentage| percent| mass)?|body fat %|skeletal muscle(?: mass)?|muscle mass|lean body mass|visceral fat(?: level| area)?|basal metabolic rate|bmr|total energy expenditure|tee)$/i;
const intake =
  /^(?:daily\s+)?(?:calories|energy|protein|carbohydrates|carbs|fat)(?:\s+(?:intake|target|recommendation|recommended|range))?$/i;

/** Conservative fallback for old Workers: copy recognizable labelled values verbatim. */
export function readingsFromReportText(text: string): BodyScanReading[] {
  const readings: BodyScanReading[] = [];
  let recommendationSection = false;
  for (const line of text.split(/\r?\n/)) {
    if (
      /^\s*(?:recommended(?: daily)?(?: nutritional)? intake|nutrition(?:al)? recommendations|daily(?: nutrition)? targets)\s*:?\s*$/i.test(
        line,
      )
    ) {
      recommendationSection = true;
      continue;
    }
    const match = line.match(/^\s*([^:\t|]{1,100})\s*[:\t|]\s*(.{1,160})\s*$/);
    if (!match) continue;
    const label = match[1].trim();
    const value = match[2].trim();
    if (!/\d/.test(value)) continue;
    const recommendedLabel = label.replace(/^recommended(?: daily)?\s+/i, '');
    const recommended =
      (recommendedLabel !== label || recommendationSection) && intake.test(recommendedLabel);
    if (!knownMeasurement.test(label) && !recommended) continue;
    if (readings.some((reading) => reading.label.toLowerCase() === label.toLowerCase())) continue;
    readings.push({ label, value, kind: recommended ? 'recommendation' : 'measurement' });
    if (readings.length === 24) break;
  }
  return readings;
}

export function hasReviewedReport(scan: Pick<BodyScan, 'text' | 'readings'>): boolean {
  return !!scan.text.trim() || !!scan.readings?.length;
}

export function formatReportReadings(readings: readonly BodyScanReading[]): string {
  return readings
    .map(
      ({ label, value, kind }) =>
        `${kind === 'recommendation' ? 'Report recommendation' : 'Measurement'} — ${label}: ${value}`,
    )
    .join('\n');
}
