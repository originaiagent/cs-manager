/**
 * period.ts の日付範囲正規化 (不良発生率ライブ化 C2-3 追加分) の単体テスト
 */
import { describe, it, expect } from 'vitest';
import {
  isValidYmd,
  jstTodayYmd,
  resolvePeriodRange,
  resolveCustomRange,
  dateRangeToUtcIso,
} from '@/lib/quality/period';

describe('isValidYmd', () => {
  it('YYYY-MM-DD の実在日のみ true', () => {
    expect(isValidYmd('2026-07-17')).toBe(true);
    expect(isValidYmd('2024-02-29')).toBe(true); // 閏年
    expect(isValidYmd('2026-02-29')).toBe(false); // 非閏年
    expect(isValidYmd('2026-02-30')).toBe(false);
    expect(isValidYmd('2026-13-01')).toBe(false);
    expect(isValidYmd('2026-7-1')).toBe(false);
    expect(isValidYmd('')).toBe(false);
    expect(isValidYmd(null)).toBe(false);
  });
});

describe('resolveCustomRange', () => {
  it('from <= to の実在日ペアのみ受理', () => {
    expect(resolveCustomRange('2026-06-01', '2026-06-30')).toEqual({
      start: '2026-06-01',
      end: '2026-06-30',
    });
    expect(resolveCustomRange('2026-06-01', '2026-06-01')).toEqual({
      start: '2026-06-01',
      end: '2026-06-01',
    });
    expect(resolveCustomRange('2026-06-30', '2026-06-01')).toBeNull(); // from > to
    expect(resolveCustomRange('2026-06-31', '2026-07-01')).toBeNull(); // 実在しない日
    expect(resolveCustomRange(undefined, '2026-07-01')).toBeNull();
  });
});

describe('resolvePeriodRange', () => {
  it('30d は今日 (JST) を含む直近 30 暦日', () => {
    const today = jstTodayYmd();
    const r = resolvePeriodRange('30d', null);
    expect(r.end).toBe(today);
    // 30 日間 (両端 inclusive)
    const days =
      (Date.parse(`${r.end}T00:00:00Z`) - Date.parse(`${r.start}T00:00:00Z`)) / 86_400_000 + 1;
    expect(days).toBe(30);
  });

  it('all は 2020-01-01 起点', () => {
    const r = resolvePeriodRange('all', null);
    expect(r.start).toBe('2020-01-01');
    expect(r.end).toBe(jstTodayYmd());
  });

  it('monthly は月初〜月末 (月の日数を正しく計算)', () => {
    expect(resolvePeriodRange('monthly', '2026-06')).toEqual({
      start: '2026-06-01',
      end: '2026-06-30',
    });
    expect(resolvePeriodRange('monthly', '2024-02')).toEqual({
      start: '2024-02-01',
      end: '2024-02-29',
    });
  });
});

describe('dateRangeToUtcIso', () => {
  it('JST 0:00 境界を UTC ISO に変換する (end は翌日 0:00 JST = exclusive)', () => {
    const { startUtc, endUtc } = dateRangeToUtcIso({ start: '2026-06-01', end: '2026-06-30' });
    expect(startUtc).toBe('2026-05-31T15:00:00.000Z'); // 6/1 0:00 JST
    expect(endUtc).toBe('2026-06-30T15:00:00.000Z'); // 7/1 0:00 JST
  });

  it('月跨ぎ・年跨ぎの繰り上がりも Date.UTC が処理する', () => {
    const { endUtc } = dateRangeToUtcIso({ start: '2025-12-01', end: '2025-12-31' });
    expect(endUtc).toBe('2025-12-31T15:00:00.000Z'); // 2026-01-01 0:00 JST
  });
});
