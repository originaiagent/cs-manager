/**
 * product-resolver の一括化 = **N+1 退行の検出テスト** (今回の再発防止の要)。
 *
 * 旧実装は id 1 件 = Core 1 リクエストを無制限並列で投げており、1 ページ描画で数百
 * リクエスト → Core 429 → 製品解決がランダムに全滅 → 本番の「不良数が全製品 0」に至った。
 * ここでは **Core 呼び出し回数が N ではなく ceil(N/500) 以下** であることを固定する。
 *
 * キャッシュ・索引がモジュールスコープのため、各テストで vi.resetModules() して
 * まっさらな状態から検証する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const OLD_ENV = { ...process.env };

/** by-ids の 1 リクエスト上限 (Core MAX_BULK と同値) */
const MAX_BULK = 500;

beforeEach(() => {
  vi.resetModules();
  process.env.CORE_API_URL = 'https://core.example.test';
  process.env.CORE_CREDENTIAL_KEY = 'test-entry-key';
});

afterEach(() => {
  process.env = { ...OLD_ENV };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Core products/by-ids のモック: ids CSV を読んで {data:[{id, product_name, ...}]} を返す */
function stubByIdsFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string | URL) => {
    const u = new URL(String(url));
    const ids = (u.searchParams.get('ids') ?? '').split(',').filter(Boolean);
    return jsonResponse({
      data: ids.map((id) => ({
        id: Number(id),
        product_name: `商品${id}`,
        variation: `色${id}`,
        product_group_id: Number(id) % 10,
      })),
      meta: { count: ids.length },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('resolveProductsByIds (N+1 退行検出)', () => {
  it('N 件でも Core 呼び出しは ceil(N/500) 回 (= N 回にならない)', async () => {
    const fetchMock = stubByIdsFetch();
    const N = 1200;
    const ids = Array.from({ length: N }, (_, i) => String(i + 1));

    const { resolveProductsByIds } = await import('@/lib/product-resolver');
    const map = await resolveProductsByIds(ids);

    const expectedCalls = Math.ceil(N / MAX_BULK); // 3
    // ここが N (=1200) になったら N+1 が復活している
    expect(fetchMock).toHaveBeenCalledTimes(expectedCalls);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(expectedCalls);
    expect(map.size).toBe(N);
    expect(map.get('1')).toMatchObject({ id: '1', name: '商品1', resolved: true, group_id: '1' });
    expect(map.get('1200')).toMatchObject({ id: '1200', resolved: true });
  });

  it('全リクエストが by-ids 一括口で、1 リクエストの ids は MAX_BULK 以下', async () => {
    const fetchMock = stubByIdsFetch();
    const ids = Array.from({ length: 501 }, (_, i) => String(i + 1));

    const { resolveProductsByIds } = await import('@/lib/product-resolver');
    await resolveProductsByIds(ids);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const u = new URL(String(call[0]));
      // 単体 /products/:id への per-id 取得に戻っていないこと
      expect(u.pathname).toBe('/api/v1/master/products/by-ids');
      const count = (u.searchParams.get('ids') ?? '').split(',').filter(Boolean).length;
      expect(count).toBeLessThanOrEqual(MAX_BULK);
    }
  });

  it('キャッシュ済み id は再取得しない / 未キャッシュ分のみ 1 本にまとめる', async () => {
    const fetchMock = stubByIdsFetch();
    const { resolveProductsByIds } = await import('@/lib/product-resolver');

    await resolveProductsByIds(['1', '2', '3']);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await resolveProductsByIds(['1', '2', '3', '4']);
    // 追加 1 本のみ (4 のみ取得)
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const u = new URL(String(fetchMock.mock.calls[1][0]));
    expect(u.searchParams.get('ids')).toBe('4');
  });

  it('Core が返さなかった id は resolved:false (現行挙動を維持)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ data: [{ id: 1, product_name: 'あり' }] })),
    );
    const { resolveProductsByIds } = await import('@/lib/product-resolver');
    const map = await resolveProductsByIds(['1', '2']);

    expect(map.get('1')).toMatchObject({ resolved: true, name: 'あり' });
    expect(map.get('2')).toEqual({ id: '2', name: 'id=2', resolved: false });
  });

  it('非正整数 id は Core へ投げず未解決扱い (不正値 1 件でチャンク全体を 400 にしない)', async () => {
    const fetchMock = stubByIdsFetch();
    const { resolveProductsByIds } = await import('@/lib/product-resolver');
    const map = await resolveProductsByIds(['1', 'abc', '0', '-3']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const u = new URL(String(fetchMock.mock.calls[0][0]));
    expect(u.searchParams.get('ids')).toBe('1'); // 正整数だけが Core へ
    expect(map.get('1')).toMatchObject({ resolved: true });
    for (const bad of ['abc', '0', '-3']) {
      expect(map.get(bad)).toEqual({ id: bad, name: `id=${bad}`, resolved: false });
    }
  });

  it('Core 全滅時は全 id を resolved:false + degraded にする (落とさない)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const { resolveProductsByIds } = await import('@/lib/product-resolver');
    const map = await resolveProductsByIds(['1', '2']);

    // 取得失敗由来の未解決は degraded で「存在しない product」と区別する
    expect(map.get('1')).toEqual({ id: '1', name: 'id=1', resolved: false, degraded: true });
    expect(map.get('2')).toEqual({ id: '2', name: 'id=2', resolved: false, degraded: true });
  });

  it('後続チャンクが失敗しても成功チャンクの id は resolved:true のまま (失敗はチャンク単位に隔離)', async () => {
    // 本番 catalog 562 件 = 2 チャンク。2 本目だけ 500 で落ちる状況を再現する。
    // 旧実装は 1 本目の 500 件を捨てて全 id を未解決にし「不良数が全製品 0」に戻していた。
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        call++;
        if (call === 2) return new Response('boom', { status: 500 });
        const u = new URL(String(url));
        const ids = (u.searchParams.get('ids') ?? '').split(',').filter(Boolean);
        return jsonResponse({
          data: ids.map((id) => ({ id: Number(id), product_name: `商品${id}`, product_group_id: 7 })),
        });
      }),
    );

    const ids = Array.from({ length: 562 }, (_, i) => String(i + 1));
    const { resolveProductsByIds } = await import('@/lib/product-resolver');
    const map = await resolveProductsByIds(ids);

    // 1 本目 (1..500) は生き残る
    expect(map.get('1')).toMatchObject({ resolved: true, name: '商品1', group_id: '7' });
    expect(map.get('500')).toMatchObject({ resolved: true, group_id: '7' });
    const resolvedCount = Array.from(map.values()).filter((p) => p.resolved).length;
    expect(resolvedCount).toBe(500);
    // 2 本目 (501..562) だけが未解決 + degraded
    expect(map.get('501')).toEqual({ id: '501', name: 'id=501', resolved: false, degraded: true });
    expect(map.get('562')).toEqual({ id: '562', name: 'id=562', resolved: false, degraded: true });
  });

  it('チャンク成功時に Core が返さなかった id は degraded を立てない (存在しない product と区別)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ data: [{ id: 1, product_name: 'あり' }] })),
    );
    const { resolveProductsByIds } = await import('@/lib/product-resolver');
    const map = await resolveProductsByIds(['1', '2']);

    expect(map.get('1')).toMatchObject({ resolved: true });
    expect(map.get('2')).toEqual({ id: '2', name: 'id=2', resolved: false });
    expect(map.get('2')?.degraded).toBeUndefined();
  });
});

describe('resolveProductGroupsByIds (N+1 退行検出)', () => {
  /** product-groups 一覧のモック (ページング envelope: {data, meta.total}) */
  function stubGroupListFetch(total: number): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = new URL(String(url));
      const limit = Number(u.searchParams.get('limit') ?? '1000');
      const offset = Number(u.searchParams.get('offset') ?? '0');
      const rows = [];
      for (let i = offset + 1; i <= Math.min(offset + limit, total); i++) {
        rows.push({ id: i, group_name: `グループ${i}`, developer: null, category: null });
      }
      return jsonResponse({ data: rows, meta: { total } });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('N 件の group 解決でも一覧 1 リクエストで済む (per-id 取得に戻らない)', async () => {
    const fetchMock = stubGroupListFetch(106);
    const ids = Array.from({ length: 100 }, (_, i) => String(i + 1));

    const { resolveProductGroupsByIds } = await import('@/lib/product-resolver');
    const map = await resolveProductGroupsByIds(ids);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const u = new URL(String(fetchMock.mock.calls[0][0]));
    expect(u.pathname).toBe('/api/v1/master/product-groups');
    expect(map.size).toBe(100);
    expect(map.get('1')).toMatchObject({ id: '1', group_name: 'グループ1', resolved: true });
  });

  it('一覧に無い id は resolved:false', async () => {
    stubGroupListFetch(3);
    const { resolveProductGroupsByIds } = await import('@/lib/product-resolver');
    const map = await resolveProductGroupsByIds(['1', '99']);

    expect(map.get('1')).toMatchObject({ resolved: true });
    expect(map.get('99')).toEqual({ id: '99', group_name: 'id=99', resolved: false });
  });

  it('一覧が引けない時は per-id fallback で解決する', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = new URL(String(url));
      if (u.pathname === '/api/v1/master/product-groups') {
        return new Response('nope', { status: 500 }); // 一覧は失敗
      }
      return jsonResponse({ data: { id: 7, group_name: '単体グループ' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { resolveProductGroupsByIds } = await import('@/lib/product-resolver');
    const map = await resolveProductGroupsByIds(['7']);

    expect(map.get('7')).toMatchObject({ group_name: '単体グループ', resolved: true });
    expect(
      fetchMock.mock.calls.some(
        (c) => new URL(String(c[0])).pathname === '/api/v1/master/product-groups/7',
      ),
    ).toBe(true);
  });
});

describe('resolveGroupChildIds (N+1 退行検出)', () => {
  /** products 一覧のモック (id, product_group_id のみ) */
  function stubProductListFetch(rows: Array<{ id: number; product_group_id: number }>) {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = new URL(String(url));
      if (u.pathname !== '/api/v1/master/products') {
        return new Response('unexpected', { status: 404 });
      }
      const limit = Number(u.searchParams.get('limit') ?? '1000');
      const offset = Number(u.searchParams.get('offset') ?? '0');
      return jsonResponse({ data: rows.slice(offset, offset + limit), meta: { total: rows.length } });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('親 N 件でも products 一覧 1 リクエストで親→子を索引する', async () => {
    const rows = [
      { id: 11, product_group_id: 1 },
      { id: 12, product_group_id: 1 },
      { id: 21, product_group_id: 2 },
      { id: 31, product_group_id: 3 },
    ];
    const fetchMock = stubProductListFetch(rows);

    const { resolveGroupChildIds } = await import('@/lib/product-resolver');
    const map = await resolveGroupChildIds(['1', '2', '3']);

    // per-id (/product-groups/:id?include=products) を 3 本投げていたら退行
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetchMock.mock.calls[0][0])).pathname).toBe('/api/v1/master/products');
    expect(map.get('1')).toEqual(['11', '12']);
    expect(map.get('2')).toEqual(['21']);
    expect(map.get('3')).toEqual(['31']);
  });

  it('子を持たない親は空配列', async () => {
    stubProductListFetch([{ id: 11, product_group_id: 1 }]);
    const { resolveGroupChildIds } = await import('@/lib/product-resolver');
    const map = await resolveGroupChildIds(['9']);
    expect(map.get('9')).toEqual([]);
  });

  it('一覧が引けない時は per-id fallback (include=products) で解決する', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = new URL(String(url));
      if (u.pathname === '/api/v1/master/products') {
        return new Response('nope', { status: 503 }); // 一覧は失敗
      }
      return jsonResponse({ data: { id: 5, products: [{ id: 51 }, { id: 52 }] } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { resolveGroupChildIds } = await import('@/lib/product-resolver');
    const map = await resolveGroupChildIds(['5']);

    expect(map.get('5')).toEqual(['51', '52']);
  });
});
