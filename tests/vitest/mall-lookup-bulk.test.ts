/**
 * Core mall-identifiers 逆引き (src/lib/core-client.ts lookupMallIdentifiersBulk) の単体テスト。
 * - チャンク分割 (MAX_BULK=500 以下で分割)
 * - 重複・空・CSV 非対応値の除外
 * - Core sendData envelope ({data: {value: {coreProductId,...} | null}}) の解釈
 * - 失敗時 throw (env 未設定 / 非 2xx)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  chunkValues,
  lookupMallIdentifiersBulk,
  MALL_LOOKUP_MAX_BULK,
} from '@/lib/core-client';

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

/** fetch mock: URL の values CSV を読んで {data: {...}} envelope を返す */
function stubLookupFetch(
  resolver: (value: string) => { coreProductId: number } | null,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string | URL) => {
    const u = new URL(String(url));
    const values = (u.searchParams.get('values') ?? '').split(',').filter(Boolean);
    const data: Record<string, { coreProductId: number; mallIdentifierId: number } | null> = {};
    for (const v of values) {
      const hit = resolver(v);
      data[v] = hit ? { coreProductId: hit.coreProductId, mallIdentifierId: 1 } : null;
    }
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('chunkValues', () => {
  it('size ごとに分割する (端数は最終チャンク)', () => {
    const values = Array.from({ length: 1200 }, (_, i) => `v${i}`);
    const chunks = chunkValues(values, 500);
    expect(chunks.map((c) => c.length)).toEqual([500, 500, 200]);
    expect(chunks[0][0]).toBe('v0');
    expect(chunks[2][199]).toBe('v1199');
  });

  it('ちょうど size 件は 1 チャンク、空配列は 0 チャンク', () => {
    expect(chunkValues(Array.from({ length: 500 }, (_, i) => i), 500)).toHaveLength(1);
    expect(chunkValues([], 500)).toEqual([]);
  });

  it('size が 0 以下は throw', () => {
    expect(() => chunkValues([1], 0)).toThrow();
  });
});

describe('lookupMallIdentifiersBulk', () => {
  it('ヒットのみ Map に入れる (null=未ヒットは含めない)', async () => {
    stubLookupFetch((v) => (v === 'item-a' ? { coreProductId: 42 } : null));
    const map = await lookupMallIdentifiersBulk('rakuten', 'identifier_1', ['item-a', 'item-b']);
    expect(map.size).toBe(1);
    expect(map.get('item-a')).toEqual({ productId: '42' });
    expect(map.has('item-b')).toBe(false);
  });

  it('MAX_BULK 超は複数リクエストにチャンク分割し結果をマージする', async () => {
    const fetchMock = stubLookupFetch((v) => ({ coreProductId: Number(v.slice(1)) }));
    const values = Array.from({ length: MALL_LOOKUP_MAX_BULK + 1 }, (_, i) => `v${i}`);
    // Amazon の ASIN 逆引きは identifier_2 (identifier_1=親ASIN。Core SDK amazonAsinMap と同一契約)
    const map = await lookupMallIdentifiersBulk('amazon', 'identifier_2', values);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 各リクエストが MAX_BULK 以下 + mallCode/slot (引数がそのまま渡ること) が正しいこと
    for (const call of fetchMock.mock.calls) {
      const u = new URL(String(call[0]));
      expect(u.pathname).toBe('/api/v1/master/mall-identifiers/lookup-bulk');
      expect(u.searchParams.get('mallCode')).toBe('amazon');
      expect(u.searchParams.get('slot')).toBe('identifier_2');
      const count = (u.searchParams.get('values') ?? '').split(',').length;
      expect(count).toBeLessThanOrEqual(MALL_LOOKUP_MAX_BULK);
    }
    expect(map.size).toBe(values.length);
    expect(map.get('v500')).toEqual({ productId: '500' });
  });

  it('slot 引数がリクエスト URL に反映される (identifier_1)', async () => {
    const fetchMock = stubLookupFetch(() => ({ coreProductId: 1 }));
    await lookupMallIdentifiersBulk('rakuten', 'identifier_1', ['item-a']);
    const u = new URL(String(fetchMock.mock.calls[0][0]));
    expect(u.searchParams.get('slot')).toBe('identifier_1');
  });

  it('重複・空・カンマ含み値は事前除外する', async () => {
    const fetchMock = stubLookupFetch(() => ({ coreProductId: 1 }));
    const map = await lookupMallIdentifiersBulk('rakuten', 'identifier_1', [
      'dup',
      'dup',
      '  ',
      '',
      'a,b', // CSV 契約のため逆引き不能 → 除外
      'solo',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const u = new URL(String(fetchMock.mock.calls[0][0]));
    expect((u.searchParams.get('values') ?? '').split(',').sort()).toEqual(['dup', 'solo']);
    expect(map.size).toBe(2);
  });

  it('values が実質空なら fetch せず空 Map', async () => {
    const fetchMock = stubLookupFetch(() => null);
    const map = await lookupMallIdentifiersBulk('rakuten', 'identifier_1', ['', '  ']);
    expect(map.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('非 2xx は throw する (status のみ、body は反射しない)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('secret detail', { status: 500, statusText: 'Internal Server Error' })),
    );
    await expect(lookupMallIdentifiersBulk('rakuten', 'identifier_1', ['x'])).rejects.toThrow(
      /Core API error: 500/,
    );
    await expect(lookupMallIdentifiersBulk('rakuten', 'identifier_1', ['x'])).rejects.not.toThrow(/secret/);
  });

  it('CORE_API_URL 未設定は throw する', async () => {
    delete process.env.CORE_API_URL;
    await expect(lookupMallIdentifiersBulk('rakuten', 'identifier_1', ['x'])).rejects.toThrow(
      /CORE_API_URL/,
    );
  });
});
