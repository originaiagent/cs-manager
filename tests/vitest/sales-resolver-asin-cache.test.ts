/**
 * resolveAmazonAsins (src/lib/quality/sales-resolver.ts) の ASIN キャッシュ + 再試行の検証。
 *
 * 背景: 不良率ページ (工場向けエビデンス) は Core lookup-bulk が一時的な 429 で throw すると
 * FBA 返品の製品紐付けがリクエスト毎に揺れていた (ok:false + 空 Map へ縮退)。
 * 本テストは根治のための ASIN→productId モジュールスコープキャッシュ (TTL 30分) と
 * 1 回だけの再試行の挙動を pin する。
 *
 * モジュールスコープのキャッシュは test ファイル内の it() 間で共有されてしまうため、
 * 各テストで vi.resetModules() → 動的 import して毎回フレッシュな状態から検証する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const lookupMock = vi.fn();
vi.mock('@/lib/core-client', () => ({
  lookupMallIdentifiersBulk: (...args: unknown[]) => lookupMock(...args),
}));

vi.mock('@/lib/product-resolver', () => ({
  resolveProductsByIds: async (ids: string[]) =>
    new Map(
      ids.map((id) => [id, { id, name: id, group_id: `g-${id}`, resolved: true }]),
    ),
}));

describe('resolveAmazonAsins ASIN キャッシュ / 再試行', () => {
  beforeEach(() => {
    vi.resetModules();
    lookupMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('(a) 2回目の呼び出しは Core lookup を呼ばない (キャッシュヒット)', async () => {
    const { resolveAmazonAsins } = await import('@/lib/quality/sales-resolver');
    lookupMock.mockResolvedValue(new Map([['B001', { productId: 'p1' }]]));

    const first = await resolveAmazonAsins(['B001']);
    expect(first.ok).toBe(true);
    expect(first.degraded).toBe(false);
    expect(first.asinToChild.get('B001')).toBe('p1');
    expect(lookupMock).toHaveBeenCalledTimes(1);

    const second = await resolveAmazonAsins(['B001']);
    expect(second.ok).toBe(true);
    expect(second.degraded).toBe(false);
    expect(second.asinToChild.get('B001')).toBe('p1');
    // キャッシュが新鮮なため 2 回目は Core へ問い合わせない
    expect(lookupMock).toHaveBeenCalledTimes(1);
  });

  it('(b) lookup 失敗 → 300ms 後の再試行で成功する', async () => {
    vi.useFakeTimers();
    const { resolveAmazonAsins } = await import('@/lib/quality/sales-resolver');
    lookupMock
      .mockRejectedValueOnce(new Error('Core API error: 429 Too Many Requests'))
      .mockResolvedValueOnce(new Map([['B002', { productId: 'p2' }]]));

    const promise = resolveAmazonAsins(['B002']);
    await vi.advanceTimersByTimeAsync(300);
    const result = await promise;

    expect(result.ok).toBe(true);
    expect(result.degraded).toBe(false);
    expect(result.asinToChild.get('B002')).toBe('p2');
    expect(lookupMock).toHaveBeenCalledTimes(2);
  });

  it('(c) 2連続失敗で degraded=true。キャッシュ済み分はそのまま返る (全滅ではないので ok=true)', async () => {
    vi.useFakeTimers();
    const { resolveAmazonAsins } = await import('@/lib/quality/sales-resolver');

    // 先に B003 をキャッシュへ載せる
    lookupMock.mockResolvedValueOnce(new Map([['B003', { productId: 'p3' }]]));
    const seeded = await resolveAmazonAsins(['B003']);
    expect(seeded.ok).toBe(true);

    // B003 (キャッシュ済) + B004 (未キャッシュ、lookup が2連続失敗)
    lookupMock
      .mockRejectedValueOnce(new Error('Core API error: 429'))
      .mockRejectedValueOnce(new Error('Core API error: 429'));
    const promise = resolveAmazonAsins(['B003', 'B004']);
    await vi.advanceTimersByTimeAsync(300);
    const result = await promise;

    expect(result.ok).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.asinToChild.get('B003')).toBe('p3');
    expect(result.asinToChild.has('B004')).toBe(false);
    // 1回 (seed 成功) + 2回 (B004 の初回+再試行)
    expect(lookupMock).toHaveBeenCalledTimes(3);
  });

  it('(c-2) キャッシュに何も無く2連続失敗した場合は全滅として ok=false', async () => {
    vi.useFakeTimers();
    const { resolveAmazonAsins } = await import('@/lib/quality/sales-resolver');
    lookupMock
      .mockRejectedValueOnce(new Error('Core API error: 429'))
      .mockRejectedValueOnce(new Error('Core API error: 429'));

    const promise = resolveAmazonAsins(['B999']);
    await vi.advanceTimersByTimeAsync(300);
    const result = await promise;

    expect(result.ok).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.asinToChild.size).toBe(0);
  });

  it('(d) null キャッシュ (Core 未登録 ASIN) は再 lookup されない', async () => {
    const { resolveAmazonAsins } = await import('@/lib/quality/sales-resolver');
    lookupMock.mockResolvedValue(new Map()); // B005 はヒットなし → null としてキャッシュ

    const first = await resolveAmazonAsins(['B005']);
    expect(first.ok).toBe(true);
    expect(first.asinToChild.has('B005')).toBe(false);
    expect(lookupMock).toHaveBeenCalledTimes(1);

    const second = await resolveAmazonAsins(['B005']);
    expect(second.ok).toBe(true);
    expect(second.degraded).toBe(false);
    expect(second.asinToChild.has('B005')).toBe(false);
    // null キャッシュのため再 lookup されない
    expect(lookupMock).toHaveBeenCalledTimes(1);
  });
});
