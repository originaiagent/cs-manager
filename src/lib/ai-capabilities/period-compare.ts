import type { DateRange } from '@/lib/quality/period';

function shiftYmd(ymd: string, days: number): string {
  const [year, month, day] = ymd.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function previousPeriodRange(range: DateRange): DateRange {
  const start = Date.UTC(...(() => {
    const [y, m, d] = range.start.split('-').map(Number);
    return [y, m - 1, d] as [number, number, number];
  })());
  const end = Date.UTC(...(() => {
    const [y, m, d] = range.end.split('-').map(Number);
    return [y, m - 1, d] as [number, number, number];
  })());
  const days = Math.floor((end - start) / 86_400_000) + 1;
  return {
    start: shiftYmd(range.start, -days),
    end: shiftYmd(range.start, -1),
  };
}
