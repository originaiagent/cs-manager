/**
 * getInboundVerifyKeys() の stale-while-error + revocation 失効 の契約テスト (vitest)。
 *
 * 接続鍵 Core 集約 Done-1 (codex APPROVE 2026-06-26):
 *  - 共有内部鍵 core_internal_shared は Core から scoped 入口鍵 (CORE_CREDENTIAL_KEY) で取得する。
 *  - 5 分 positive cache。さらに直近成功値を 60 分まで last-good 保持。
 *  - stale-while-error は **transient 障害(network/timeout=status null, または 5xx)のみ**。
 *  - 非 transient(401/403/404 等 4xx=revocation) と api_key 不在は last-good を破棄して即 fail-closed
 *    (後続の transient 障害で失効鍵を stale 復活させない)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getInboundVerifyKeys,
  _clearCredentialCacheForTest,
  _clearPositiveCacheForTest,
} from '@/lib/credentials';

function okJson(api_key: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      service_code: 'core_internal_shared',
      scope_key: null,
      credentials: api_key === undefined ? {} : { api_key },
      metadata: {},
      valid_from: '2026-01-01T00:00:00Z',
      valid_to: null,
    }),
    arrayBuffer: async () => new ArrayBuffer(0),
    text: async () => '',
  } as unknown as Response;
}

function httpErr(status: number): Response {
  return {
    ok: false,
    status,
    statusText: `HTTP ${status}`,
    json: async () => ({}),
    arrayBuffer: async () => new ArrayBuffer(0),
    text: async () => '',
  } as unknown as Response;
}

describe('getInboundVerifyKeys — stale-while-error + revocation', () => {
  beforeEach(() => {
    process.env.CORE_API_URL = 'https://core.example.test';
    process.env.CORE_CREDENTIAL_KEY = 'scoped-entry-key';
    delete process.env.INTERNAL_API_KEY;
    delete process.env.EMBED_MCP_VALIDATE_KEY;
    _clearCredentialCacheForTest();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    _clearCredentialCacheForTest();
  });

  it('成功時は Core の api_key を返す', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson('SHARED-A')));
    expect(await getInboundVerifyKeys()).toEqual(['SHARED-A']);
  });

  it('transient(network)障害は直近成功値を stale で返す', async () => {
    const fetchMock = vi.fn(async () => okJson('SHARED-A'));
    vi.stubGlobal('fetch', fetchMock);
    expect(await getInboundVerifyKeys()).toEqual(['SHARED-A']); // last-good 確立
    _clearPositiveCacheForTest(); // 5 分 TTL 失効を再現
    fetchMock.mockImplementationOnce(async () => {
      throw new Error('network down');
    });
    expect(await getInboundVerifyKeys()).toEqual(['SHARED-A']); // stale 継続
  });

  it('transient(5xx)障害も stale で返す', async () => {
    const fetchMock = vi.fn(async () => okJson('SHARED-A'));
    vi.stubGlobal('fetch', fetchMock);
    expect(await getInboundVerifyKeys()).toEqual(['SHARED-A']);
    _clearPositiveCacheForTest();
    fetchMock.mockImplementationOnce(async () => httpErr(503));
    expect(await getInboundVerifyKeys()).toEqual(['SHARED-A']);
  });

  it('非 transient(403 revocation)は fail-closed、かつ last-good を破棄して transient 復活も防ぐ', async () => {
    const fetchMock = vi.fn(async () => okJson('SHARED-A'));
    vi.stubGlobal('fetch', fetchMock);
    expect(await getInboundVerifyKeys()).toEqual(['SHARED-A']); // last-good 確立
    _clearPositiveCacheForTest();
    fetchMock.mockImplementationOnce(async () => httpErr(403)); // 失効
    expect(await getInboundVerifyKeys()).toEqual([]); // 即 fail-closed
    _clearPositiveCacheForTest();
    fetchMock.mockImplementationOnce(async () => httpErr(503)); // その後 transient
    expect(await getInboundVerifyKeys()).toEqual([]); // 失効鍵を stale 復活させない
  });

  it('api_key 不在(200)も fail-closed、かつ last-good を破棄する', async () => {
    const fetchMock = vi.fn(async () => okJson('SHARED-A'));
    vi.stubGlobal('fetch', fetchMock);
    expect(await getInboundVerifyKeys()).toEqual(['SHARED-A']);
    _clearPositiveCacheForTest();
    fetchMock.mockImplementationOnce(async () => okJson(undefined)); // api_key 削除
    expect(await getInboundVerifyKeys()).toEqual([]);
    _clearPositiveCacheForTest();
    fetchMock.mockImplementationOnce(async () => httpErr(500));
    expect(await getInboundVerifyKeys()).toEqual([]); // 復活しない
  });

  it('last-good なしで障害時は fail-closed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => httpErr(500)));
    expect(await getInboundVerifyKeys()).toEqual([]);
  });
});
