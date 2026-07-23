import type { DefectCaseDetail } from '@/lib/quality/defect-aggregate';
import type { DateRange } from '@/lib/quality/period';

export type BucketGranularity = 'month' | 'week';

function parseYmd(ymd: string): Date {
  const [year, month, day] = ymd.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function formatYmd(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function addDays(ymd: string, days: number): string {
  const date = parseYmd(ymd);
  date.setUTCDate(date.getUTCDate() + days);
  return formatYmd(date);
}

function weekBucket(ymd: string): string {
  const date = parseYmd(ymd);
  const daysFromMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysFromMonday);
  return formatYmd(date);
}

function bucketOf(ymd: string, granularity: BucketGranularity): string {
  return granularity === 'month' ? ymd.slice(0, 7) : weekBucket(ymd);
}

export function bucketCasesByPeriod(
  cases: readonly DefectCaseDetail[],
  range: DateRange,
  granularity: BucketGranularity,
): Array<{ bucket: string; count: number }> {
  const counts = new Map<string, number>();
  if (granularity === 'month') {
    let cursor = `${range.start.slice(0, 7)}-01`;
    while (cursor.slice(0, 7) <= range.end.slice(0, 7)) {
      counts.set(cursor.slice(0, 7), 0);
      const date = parseYmd(cursor);
      date.setUTCMonth(date.getUTCMonth() + 1);
      cursor = formatYmd(date);
    }
  } else {
    let cursor = weekBucket(range.start);
    const last = weekBucket(range.end);
    while (cursor <= last) {
      counts.set(cursor, 0);
      cursor = addDays(cursor, 7);
    }
  }
  for (const detail of cases) {
    if (!detail.occurred_date || detail.occurred_date < range.start || detail.occurred_date > range.end) {
      continue;
    }
    const bucket = bucketOf(detail.occurred_date, granularity);
    if (counts.has(bucket)) counts.set(bucket, (counts.get(bucket) ?? 0) + detail.count);
  }
  return Array.from(counts, ([bucket, count]) => ({ bucket, count }));
}
