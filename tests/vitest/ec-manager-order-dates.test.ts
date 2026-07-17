/**
 * ec-manager client fetchOrderDates (C3a-3) の単体テスト。
 * - 500 件チャンク分割・重複/空の除去・複数チャンクのマージ
 * - 1 チャンクでも失敗したら全体 ok:false (部分成功を成功扱いしない)
 * - 鍵は Core 失敗時 env フォールバック (他 fetch 系と同流儀)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchOrderDates, ORDER_DATES_CHUNK_SIZE } from '@/lib/ec-manager/client';

const OLD_ENV = { ...process.env };

beforeEach(() => {
  // Core (getCredential) は CORE_API_URL 未設定 throw → env EC_MANAGER_API_KEY フォールバック
  delete process.env.CORE_API_URL;
  process.env.EC_MANAGER_API_URL = 'https://ec-manager.example.test';
  process.env.EC_MANAGER_API_KEY = 'test-api-key';
});

afterEach(() => {
  process.env = { ...OLD_ENV };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** fetch mock: orderIds CSV を読んで {dates: {id: date}} を返す */
function stubOrderDatesFetch(
  resolver: (orderId: string) => string | null,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string | URL) => {
    const u = new URL(String(url));
    const ids = (u.searchParams.get('orderIds') ?? '').split(',').filter(Boolean);
    const dates: Record<string, string> = {};
    for (const id of ids) {
      const d = resolver(id);
      if (d) dates[id] = d;
    }
    return new Response(JSON.stringify({ dates }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('fetchOrderDates', () => {
  it('500 件を超える orderIds はチャンク分割し結果をマージする', async () => {
    const ids = Array.from({ length: 600 }, (_, i) => `249-0000000-${String(i).padStart(7, '0')}`);
    const fetchMock = stubOrderDatesFetch(() => '2026-07-01');

    const r = await fetchOrderDates(ids);
    expect(r.ok).toBe(true);
    expect(Object.keys(r.dates ?? {})).toHaveLength(600);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 500 + 100

    // 1 チャンク目はちょうど上限件数
    const firstUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(firstUrl.pathname).toBe('/api/external/order-dates');
    expect((firstUrl.searchParams.get('orderIds') ?? '').split(',')).toHaveLength(
      ORDER_DATES_CHUNK_SIZE,
    );
  });

  it('重複・空白の orderId は除去して問い合わせる', async () => {
    const fetchMock = stubOrderDatesFetch(() => '2026-07-01');
    const r = await fetchOrderDates(['249-1111111-1111111', '249-1111111-1111111', ' ', '']);
    expect(r.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get('orderIds')).toBe('249-1111111-1111111');
  });

  it('orderIds が空なら fetch せず ok:true / 空 dates', async () => {
    const fetchMock = stubOrderDatesFetch(() => null);
    const r = await fetchOrderDates([]);
    expect(r).toEqual({ ok: true, dates: {} });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ヒットしない orderId はキー自体が無い', async () => {
    stubOrderDatesFetch((id) => (id.endsWith('1') ? '2026-07-01' : null));
    const r = await fetchOrderDates(['249-0000000-0000001', '249-0000000-0000002']);
    expect(r.ok).toBe(true);
    expect(r.dates).toEqual({ '249-0000000-0000001': '2026-07-01' });
  });

  it('非 2xx は ok:false (body は反射しない・status のみ)', async () => {
    const fetchMock = vi.fn(async () => new Response('secret detail', { status: 500, statusText: 'Internal Server Error' }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await fetchOrderDates(['249-1111111-1111111']);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('500');
    expect(r.error).not.toContain('secret');
  });

  it('複数チャンクの途中で失敗したら全体 ok:false (部分成功を成功扱いしない)', async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 2) return new Response('err', { status: 502, statusText: 'Bad Gateway' });
      return new Response(JSON.stringify({ dates: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const ids = Array.from({ length: 600 }, (_, i) => `id-${i}`);
    const r = await fetchOrderDates(ids);
    expect(r.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
