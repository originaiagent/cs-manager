/**
 * Core products 一括取得 (src/lib/core-client.ts fetchProductsByIds) の単体テスト。
 * - チャンク分割 (MAX_BULK=500 以下で分割)
 * - Core sendData envelope ({data: [product...], meta}) の解釈
 * - 重複除去 / 空入力
 * - 失敗系 (env 未設定 / 非 2xx は status のみで body を反射しない)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchProductsByIds, PRODUCTS_BY_IDS_MAX_BULK } from '@/lib/core-client';

const OLD_ENV = { ...process.env };

beforeEach(() => {
  process.env.CORE_API_URL = 'https://core.example.test';
  process.env.CORE_CREDENTIAL_KEY = 'test-entry-key';
});

afterEach(() => {
  process.env = { ...OLD_ENV };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** ids CSV を読んで {data:[...]} envelope を返す fetch mock */
function stubByIdsFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string | URL) => {
    const u = new URL(String(url));
    const ids = (u.searchParams.get('ids') ?? '').split(',').filter(Boolean);
    return new Response(
      JSON.stringify({
        data: ids.map((id) => ({ id: Number(id), product_name: `商品${id}`, product_group_id: 7 })),
        meta: { count: ids.length },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('fetchProductsByIds', () => {
  it('envelope {data:[...]} を products として返す', async () => {
    stubByIdsFetch();
    const r = await fetchProductsByIds(['1', '2']);
    expect(r.ok).toBe(true);
    expect(r.products).toHaveLength(2);
    expect(r.products?.[0]).toMatchObject({ id: 1, product_name: '商品1', product_group_id: 7 });
  });

  it('by-ids エンドポイントを叩き、必要 fields を要求する', async () => {
    const fetchMock = stubByIdsFetch();
    await fetchProductsByIds(['1']);
    const u = new URL(String(fetchMock.mock.calls[0][0]));
    expect(u.pathname).toBe('/api/v1/master/products/by-ids');
    expect(u.searchParams.get('ids')).toBe('1');
    const fields = (u.searchParams.get('fields') ?? '').split(',');
    expect(fields).toContain('id');
    expect(fields).toContain('product_name');
    expect(fields).toContain('variation');
    expect(fields).toContain('product_group_id');
  });

  it('MAX_BULK 超は複数リクエストにチャンク分割し結果をマージする', async () => {
    const fetchMock = stubByIdsFetch();
    const ids = Array.from({ length: PRODUCTS_BY_IDS_MAX_BULK + 1 }, (_, i) => String(i + 1));
    const r = await fetchProductsByIds(ids);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const u = new URL(String(call[0]));
      const count = (u.searchParams.get('ids') ?? '').split(',').filter(Boolean).length;
      expect(count).toBeLessThanOrEqual(PRODUCTS_BY_IDS_MAX_BULK);
    }
    expect(r.products).toHaveLength(ids.length);
  });

  it('重複・空白 id は除外して 1 本にまとめる', async () => {
    const fetchMock = stubByIdsFetch();
    const r = await fetchProductsByIds(['5', '5', ' 6 ', '', '  ']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const u = new URL(String(fetchMock.mock.calls[0][0]));
    expect(u.searchParams.get('ids')).toBe('5,6');
    expect(r.ok).toBe(true);
  });

  it('実質空の入力は fetch せず ok:true / 空配列', async () => {
    const fetchMock = stubByIdsFetch();
    const r = await fetchProductsByIds(['', '   ']);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: true, products: [] });
  });

  it('非 2xx は ok:false (status のみ、body は反射しない)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('secret detail', { status: 400, statusText: 'Bad Request' })),
    );
    const r = await fetchProductsByIds(['1']);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/400/);
    expect(r.error).not.toMatch(/secret/);
    // 全チャンク失敗 = products 空 + 全 id が failedIds
    expect(r.products).toEqual([]);
    expect(r.failedIds).toEqual(['1']);
  });

  it('一部チャンク失敗でも成功チャンクの products は捨てない (ok:false + failedIds で隔離)', async () => {
    let call = 0;
    const fetchMock = vi.fn(async (url: string | URL) => {
      call++;
      if (call === 2) return new Response('boom', { status: 500, statusText: 'Server Error' });
      const u = new URL(String(url));
      const ids = (u.searchParams.get('ids') ?? '').split(',').filter(Boolean);
      return new Response(JSON.stringify({ data: ids.map((id) => ({ id: Number(id) })) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const ids = Array.from({ length: PRODUCTS_BY_IDS_MAX_BULK + 62 }, (_, i) => String(i + 1));
    const r = await fetchProductsByIds(ids);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r.ok).toBe(false); // 縮退したことは呼出側へ伝える
    // 1 本目の 500 件は生きている (旧実装はここで捨てて全 id 未解決 = 不良数 0 に戻していた)
    expect(r.products).toHaveLength(PRODUCTS_BY_IDS_MAX_BULK);
    expect(r.failedIds).toHaveLength(62);
    expect(r.failedIds?.[0]).toBe(String(PRODUCTS_BY_IDS_MAX_BULK + 1));
    expect(r.error).toMatch(/500/);
  });

  it('timeout / network エラーもチャンク単位に閉じ込める (成功分は残る)', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        call++;
        if (call === 2) {
          const e = new Error('The operation was aborted');
          e.name = 'TimeoutError';
          throw e;
        }
        const u = new URL(String(url));
        const ids = (u.searchParams.get('ids') ?? '').split(',').filter(Boolean);
        return new Response(JSON.stringify({ data: ids.map((id) => ({ id: Number(id) })) }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    const ids = Array.from({ length: PRODUCTS_BY_IDS_MAX_BULK + 3 }, (_, i) => String(i + 1));
    const r = await fetchProductsByIds(ids);

    expect(r.ok).toBe(false);
    expect(r.products).toHaveLength(PRODUCTS_BY_IDS_MAX_BULK);
    expect(r.failedIds).toHaveLength(3);
    expect(r.error).toMatch(/Timeout/);
  });

  it('CORE_API_URL 未設定は ok:false (throw しない)', async () => {
    delete process.env.CORE_API_URL;
    const r = await fetchProductsByIds(['1']);
    expect(r).toEqual({ ok: false, error: 'CORE_API_URL is not set' });
  });

  it('CORE_CREDENTIAL_KEY 未設定は ok:false (throw しない)', async () => {
    delete process.env.CORE_CREDENTIAL_KEY;
    const r = await fetchProductsByIds(['1']);
    expect(r).toEqual({ ok: false, error: 'CORE_CREDENTIAL_KEY is not set' });
  });

  it('network エラーは ok:false (throw しない)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    const r = await fetchProductsByIds(['1']);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Network error/);
  });
});
