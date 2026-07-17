/**
 * 注文日解決 (src/lib/quality/order-dates.ts C3a-3) の単体テスト。
 * - 楽天注文番号のローカルパース (defensive: 形式一致 + 実在日のみ)
 * - Amazon 注文 ID 判定と振り分け
 * - resolveOrderDates: 楽天ローカル + Amazon API 合成 / API 失敗時の縮退
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseRakutenOrderDate,
  isAmazonOrderId,
  partitionOrderNumbers,
  resolveOrderDates,
} from '@/lib/quality/order-dates';
import { fetchOrderDates } from '@/lib/ec-manager/client';

vi.mock('@/lib/ec-manager/client', () => ({
  fetchOrderDates: vi.fn(),
}));

const fetchOrderDatesMock = vi.mocked(fetchOrderDates);

beforeEach(() => {
  fetchOrderDatesMock.mockReset();
});

describe('parseRakutenOrderDate', () => {
  it('店舗ID6桁-注文日8桁-連番 形式から注文日をパースする', () => {
    expect(parseRakutenOrderDate('408672-20260701-0123456789')).toBe('2026-07-01');
    expect(parseRakutenOrderDate('123456-20251231-1')).toBe('2025-12-31');
    expect(parseRakutenOrderDate('  408672-20260701-0123456789  ')).toBe('2026-07-01');
  });

  it('形式不一致は null (Amazon 3-7-7 / 自由文字列 / 桁ズレ)', () => {
    expect(parseRakutenOrderDate('249-1111111-1111111')).toBeNull(); // Amazon 形式
    expect(parseRakutenOrderDate('40867-20260701-0123456789')).toBeNull(); // 店舗ID5桁
    expect(parseRakutenOrderDate('408672-2026070-0123456789')).toBeNull(); // 日付7桁
    expect(parseRakutenOrderDate('408672-20260701')).toBeNull(); // 連番なし
    expect(parseRakutenOrderDate('memo:408672-20260701-01')).toBeNull(); // 前置文字
    expect(parseRakutenOrderDate('')).toBeNull();
    expect(parseRakutenOrderDate(null)).toBeNull();
    expect(parseRakutenOrderDate(undefined)).toBeNull();
  });

  it('実在しない日付は null (defensive)', () => {
    expect(parseRakutenOrderDate('408672-20260230-0123456789')).toBeNull(); // 2月30日
    expect(parseRakutenOrderDate('408672-20261301-0123456789')).toBeNull(); // 13月
  });
});

describe('isAmazonOrderId', () => {
  it('3-7-7 形式のみ true', () => {
    expect(isAmazonOrderId('249-1111111-1111111')).toBe(true);
    expect(isAmazonOrderId('503-3333333-3333333')).toBe(true);
    expect(isAmazonOrderId('408672-20260701-0123456789')).toBe(false);
    expect(isAmazonOrderId('249-111-1111111')).toBe(false);
    expect(isAmazonOrderId('')).toBe(false);
    expect(isAmazonOrderId(null)).toBe(false);
  });
});

describe('partitionOrderNumbers', () => {
  it('楽天/Amazon/解決不能に振り分ける (重複・空は除去)', () => {
    const r = partitionOrderNumbers([
      '408672-20260701-0123456789',
      '249-1111111-1111111',
      '249-1111111-1111111', // 重複
      'yahoo-abc-123',
      '',
      '  ',
    ]);
    expect(Object.fromEntries(r.dates)).toEqual({
      '408672-20260701-0123456789': '2026-07-01',
    });
    expect(r.amazonIds).toEqual(['249-1111111-1111111']);
    expect(r.unresolved).toEqual(['yahoo-abc-123']);
  });
});

describe('resolveOrderDates', () => {
  it('楽天はローカルパース、Amazon は API 結果を合成する', async () => {
    fetchOrderDatesMock.mockResolvedValue({
      ok: true,
      dates: { '249-1111111-1111111': '2026-06-15' },
    });
    const r = await resolveOrderDates([
      '408672-20260701-0123456789',
      '249-1111111-1111111',
      '249-9999999-9999999', // API 側でヒットしない
    ]);
    expect(r.amazonLookupFailed).toBe(false);
    expect(Object.fromEntries(r.dates)).toEqual({
      '408672-20260701-0123456789': '2026-07-01',
      '249-1111111-1111111': '2026-06-15',
    });
    expect(fetchOrderDatesMock).toHaveBeenCalledWith([
      '249-1111111-1111111',
      '249-9999999-9999999',
    ]);
  });

  it('Amazon ID が無ければ API を呼ばない', async () => {
    const r = await resolveOrderDates(['408672-20260701-0123456789', 'free-text']);
    expect(fetchOrderDatesMock).not.toHaveBeenCalled();
    expect(r.amazonLookupFailed).toBe(false);
    expect(r.dates.size).toBe(1);
  });

  it('API 失敗時は throw せず楽天分のみ返し amazonLookupFailed=true', async () => {
    fetchOrderDatesMock.mockResolvedValue({ ok: false, error: 'ec-manager API error: 500' });
    const r = await resolveOrderDates([
      '408672-20260701-0123456789',
      '249-1111111-1111111',
    ]);
    expect(r.amazonLookupFailed).toBe(true);
    expect(Object.fromEntries(r.dates)).toEqual({
      '408672-20260701-0123456789': '2026-07-01',
    });
  });

  it('API 応答の不正な日付値は採用しない (defensive)', async () => {
    fetchOrderDatesMock.mockResolvedValue({
      ok: true,
      dates: { '249-1111111-1111111': '2026-02-30' }, // 実在しない日
    });
    const r = await resolveOrderDates(['249-1111111-1111111']);
    expect(r.dates.size).toBe(0);
    expect(r.amazonLookupFailed).toBe(false);
  });
});
