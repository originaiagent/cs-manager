import { describe, expect, it } from 'vitest';
import { previousPeriodRange } from '@/lib/ai-capabilities/period-compare';

describe('previousPeriodRange', () => {
  it('同じ日数の直前期間を返す', () => {
    expect(previousPeriodRange({ start: '2026-07-01', end: '2026-07-30' })).toEqual({
      start: '2026-06-01',
      end: '2026-06-30',
    });
  });

  it('月・年境界と閏日をUTC暦日で扱う', () => {
    expect(previousPeriodRange({ start: '2024-03-01', end: '2024-03-02' })).toEqual({
      start: '2024-02-28',
      end: '2024-02-29',
    });
  });
});
