import { describe, it, expect, beforeEach } from 'vitest';
import { ProxyAgent } from 'undici';
import {
  getYahooEgressDispatcher,
  createYahooProxiedFetch,
  YahooEgressProxyError,
  _clearYahooEgressCacheForTest,
} from '@/channels/yahoo/egress';
import { _clearCredentialCacheForTest } from '@/lib/credentials';

/**
 * Yahoo egress 固定IPプロキシ配線のテスト。
 *  - Core から proxy 接続情報を解決し undici ProxyAgent dispatcher を構築する。
 *  - credential 不在/不完全時は fail-closed (throw)。直 fetch に落とさない。
 *
 * Core 呼び出しは getCredential の opts(fetchImpl/coreApiUrl/internalApiKey) 注入で差し替える。
 */

const CORE_URL = 'https://core.test';
const ENTRY_KEY = 'test-entry-key';

// proxy credential JSON を返す fake Core /api/credentials
function fakeCore(credentials: Record<string, unknown>): typeof fetch {
  return (async (input: any) => {
    const url = String(input);
    if (url.includes('/api/credentials/yahoo_egress_proxy')) {
      return new Response(
        JSON.stringify({
          service_code: 'yahoo_egress_proxy',
          scope_key: null,
          credentials,
          metadata: {},
          valid_from: new Date(0).toISOString(),
          valid_to: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

// 404 (credential 未投入) を返す fake Core
const fakeCore404: typeof fetch = (async () =>
  new Response('not found', { status: 404 })) as unknown as typeof fetch;

const COMPLETE_CREDS = {
  host: '104.198.123.146',
  port: '8888',
  username: 'csmanager',
  password: 'secret-pass-value',
};

const injectOpts = (fetchImpl: typeof fetch) => ({
  fetchImpl,
  coreApiUrl: CORE_URL,
  internalApiKey: ENTRY_KEY,
  forceRefresh: true,
});

describe('yahoo egress proxy wiring', () => {
  beforeEach(() => {
    _clearYahooEgressCacheForTest();
    _clearCredentialCacheForTest();
  });

  it('builds a ProxyAgent dispatcher from complete Core credential', async () => {
    const agent = await getYahooEgressDispatcher(
      'yahoo_egress_proxy',
      injectOpts(fakeCore(COMPLETE_CREDS)),
    );
    expect(agent).toBeInstanceOf(ProxyAgent);
  });

  it('fail-closed: throws YahooEgressProxyError when credential is absent (404)', async () => {
    await expect(
      getYahooEgressDispatcher('yahoo_egress_proxy', injectOpts(fakeCore404)),
    ).rejects.toBeInstanceOf(YahooEgressProxyError);
  });

  it('fail-closed: throws when credential is incomplete (missing password)', async () => {
    const { password: _omit, ...incomplete } = COMPLETE_CREDS;
    await expect(
      getYahooEgressDispatcher('yahoo_egress_proxy', injectOpts(fakeCore(incomplete))),
    ).rejects.toBeInstanceOf(YahooEgressProxyError);
  });

  it('never embeds credentials in the error message (no value leak)', async () => {
    const { password: _omit, ...incomplete } = COMPLETE_CREDS;
    try {
      await getYahooEgressDispatcher('yahoo_egress_proxy', injectOpts(fakeCore(incomplete)));
      throw new Error('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain(COMPLETE_CREDS.host);
      expect(msg).not.toContain(COMPLETE_CREDS.username);
    }
  });

  it('createYahooProxiedFetch returns a FetchLike that fail-closes when proxy is unavailable', async () => {
    const proxiedFetch = createYahooProxiedFetch('yahoo_egress_proxy', injectOpts(fakeCore404));
    await expect(
      proxiedFetch('https://circus.shopping.yahooapis.jp/', { method: 'GET' }),
    ).rejects.toBeInstanceOf(YahooEgressProxyError);
  });
});
