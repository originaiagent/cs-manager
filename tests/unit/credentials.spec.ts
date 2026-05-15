import { test, expect } from '@playwright/test';
import {
  getCredential,
  getCredentialsParallel,
  CredentialFetchError,
  _clearCredentialCacheForTest,
  type CredentialResponse,
} from '../../src/lib/credentials/index';

const COMMON_OPTS = {
  coreApiUrl: 'https://core.test',
  internalApiKey: 'test-key',
};

function makeFetch(handler: (url: URL, init?: RequestInit) => Response): typeof fetch {
  return (input: any, init?: any) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    return Promise.resolve(handler(url, init));
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test.describe('getCredential', () => {
  test.beforeEach(() => {
    _clearCredentialCacheForTest();
  });

  test('Core API を呼び credentials を返す', async () => {
    let calledUrl = '';
    let calledHeaders: Record<string, string> = {};
    const fetchImpl = makeFetch((url, init) => {
      calledUrl = url.toString();
      calledHeaders = (init?.headers ?? {}) as Record<string, string>;
      return jsonResponse({
        service_code: 'rakuten_rmesse',
        scope_key: 'shop_001',
        credentials: { rms_user: 'u', service_secret: 's', license_key: 'l', dev_auth_key: 'd' },
        metadata: {},
        valid_from: '2026-04-01T00:00:00Z',
        valid_to: null,
      });
    });

    const r = await getCredential('rakuten_rmesse', 'shop_001', { ...COMMON_OPTS, fetchImpl });
    expect(r.service_code).toBe('rakuten_rmesse');
    expect(r.scope_key).toBe('shop_001');
    expect((r.credentials as any).service_secret).toBe('s');
    expect(calledUrl).toBe('https://core.test/api/credentials/rakuten_rmesse?scope_key=shop_001');
    expect(calledHeaders['X-Internal-API-Key']).toBe('test-key');
  });

  test('5 分以内の再取得はキャッシュヒット (fetch が 1 回のみ)', async () => {
    let callCount = 0;
    const fetchImpl = makeFetch(() => {
      callCount += 1;
      return jsonResponse({
        service_code: 'rakuten_rmesse',
        scope_key: null,
        credentials: { v: 'cached' },
        metadata: {},
        valid_from: '2026-04-01T00:00:00Z',
        valid_to: null,
      });
    });

    await getCredential('rakuten_rmesse', null, { ...COMMON_OPTS, fetchImpl });
    await getCredential('rakuten_rmesse', null, { ...COMMON_OPTS, fetchImpl });
    expect(callCount).toBe(1);
  });

  test('forceRefresh=true でキャッシュをバイパス', async () => {
    let callCount = 0;
    const fetchImpl = makeFetch(() => {
      callCount += 1;
      return jsonResponse({
        service_code: 'rakuten_rmesse',
        scope_key: null,
        credentials: {},
        metadata: {},
        valid_from: '2026-04-01T00:00:00Z',
        valid_to: null,
      });
    });

    await getCredential('rakuten_rmesse', null, { ...COMMON_OPTS, fetchImpl });
    await getCredential('rakuten_rmesse', null, { ...COMMON_OPTS, fetchImpl, forceRefresh: true });
    expect(callCount).toBe(2);
  });

  test('scope_key の異なる呼び出しは別キャッシュ', async () => {
    let callCount = 0;
    const fetchImpl = makeFetch((url) => {
      callCount += 1;
      return jsonResponse({
        service_code: 'rakuten_rmesse',
        scope_key: url.searchParams.get('scope_key'),
        credentials: { shop: url.searchParams.get('scope_key') },
        metadata: {},
        valid_from: '2026-04-01T00:00:00Z',
        valid_to: null,
      });
    });

    const a = await getCredential('rakuten_rmesse', 'shop_a', { ...COMMON_OPTS, fetchImpl });
    const b = await getCredential('rakuten_rmesse', 'shop_b', { ...COMMON_OPTS, fetchImpl });
    expect(callCount).toBe(2);
    expect((a.credentials as any).shop).toBe('shop_a');
    expect((b.credentials as any).shop).toBe('shop_b');
  });

  test('401 → CredentialFetchError(status=401)', async () => {
    const fetchImpl = makeFetch(
      () => new Response(JSON.stringify({ error: 'unauth' }), { status: 401 }),
    );
    await expect(
      getCredential('rakuten_rmesse', null, { ...COMMON_OPTS, fetchImpl }),
    ).rejects.toMatchObject({
      name: 'CredentialFetchError',
      status: 401,
    });
  });

  test('404 → CredentialFetchError(status=404)', async () => {
    const fetchImpl = makeFetch(() => new Response('{"error":"not found"}', { status: 404 }));
    await expect(
      getCredential('rakuten_rmesse', null, { ...COMMON_OPTS, fetchImpl }),
    ).rejects.toMatchObject({
      name: 'CredentialFetchError',
      status: 404,
    });
  });

  test('CORE_API_URL 未設定 → CredentialFetchError(status=null)', async () => {
    // 空文字で「設定なし」をシミュレート (undefined だと環境変数 fallback が効くため)
    await expect(
      getCredential('rakuten_rmesse', null, {
        coreApiUrl: '',
        internalApiKey: 'k',
      }),
    ).rejects.toMatchObject({ name: 'CredentialFetchError', status: null });
  });

  test('INTERNAL_API_KEY 未設定 → CredentialFetchError', async () => {
    await expect(
      getCredential('rakuten_rmesse', null, {
        coreApiUrl: 'https://core.test',
        internalApiKey: '',
      }),
    ).rejects.toMatchObject({ name: 'CredentialFetchError' });
  });

  test('getCredentialsParallel: 複数 credential を並列取得', async () => {
    const fetchImpl = makeFetch((url) => {
      return jsonResponse({
        service_code: url.pathname.split('/').pop(),
        scope_key: url.searchParams.get('scope_key'),
        credentials: { svc: url.pathname.split('/').pop() },
        metadata: {},
        valid_from: '2026-04-01T00:00:00Z',
        valid_to: null,
      });
    });

    const results = await getCredentialsParallel(
      [
        { serviceCode: 'svc_a', scopeKey: 'x' },
        { serviceCode: 'svc_b', scopeKey: 'y' },
      ],
      { ...COMMON_OPTS, fetchImpl },
    );
    expect(results.length).toBe(2);
    expect((results[0].credentials as any).svc).toBe('svc_a');
    expect((results[1].credentials as any).svc).toBe('svc_b');
  });
});
