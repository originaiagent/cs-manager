import { describe, expect, it } from 'vitest';
import { bucketCasesByPeriod } from '@/lib/ai-capabilities/time-buckets';
import type { DefectCaseDetail } from '@/lib/quality/defect-aggregate';

function detail(date: string, count = 1): DefectCaseDetail {
  return {
    occurred_date: date,
    order_date: null,
    sources: ['ticket'],
    causes: [],
    order_numbers: [],
    count,
  };
}

describe('bucketCasesByPeriod', () => {
  it('月バケットを期間全体で0埋めし、case.countを加算する', () => {
    expect(
      bucketCasesByPeriod(
        [detail('2026-01-31', 2), detail('2026-03-01')],
        { start: '2026-01-15', end: '2026-03-02' },
        'month',
      ),
    ).toEqual([
      { bucket: '2026-01', count: 2 },
      { bucket: '2026-02', count: 0 },
      { bucket: '2026-03', count: 1 },
    ]);
  });

  it('JST暦日の月曜を週バケット開始日にする', () => {
    expect(
      bucketCasesByPeriod(
        [detail('2026-07-19'), detail('2026-07-20', 2)],
        { start: '2026-07-14', end: '2026-07-21' },
        'week',
      ),
    ).toEqual([
      { bucket: '2026-07-13', count: 1 },
      { bucket: '2026-07-20', count: 2 },
    ]);
  });
});
