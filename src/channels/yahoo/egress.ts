/**
 * Yahoo egress fixed-IP proxy 配線
 *
 * 目的: cs-manager から Yahoo API を叩く fetch だけを、GCP に立てた固定IP送信専用
 *       フォワードプロキシ (tinyproxy / asia-northeast1 / 104.198.123.146) 経由にする。
 *       Vercel の egress IP は毎回変わるが、Yahoo の利用申請は固定IPの登録を要求するため。
 *
 * 方式 (codex 設計 APPROVE 2026-06-28):
 *  - Next.js 組込 fetch(Undici) は HTTPS_PROXY env を無視するため、env 設定では効かない。
 *    undici `ProxyAgent` dispatcher を Yahoo 呼び出し箇所に **明示注入**する。
 *  - proxy の接続情報 (host/port/username/password) は Core `yahoo_egress_proxy` から
 *    `CORE_CREDENTIAL_KEY` 経由で動的取得 (5分TTL)。コード/env にハードコードしない。
 *  - 認証は ProxyAgent の `token`(Proxy-Authorization ヘッダ) で渡し、認証情報入りの URL 文字列は
 *    組まない (creds が URL/ログに出ないようにする)。値はログに出さない。
 *  - **fail-closed**: proxy credential が取得不能なら throw する。直 fetch へ黙ってフォールバック
 *    しない (= Yahoo 通信が固定IP以外から漏れるのを防ぐ)。Yahoo 同期はその回スキップ/エラー化。
 *
 * 他チャネル (楽天/メール/LINE) はこのモジュールを使わない = proxy 非経由 (従来どおり)。
 */
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import {
  getCredential,
  CredentialFetchError,
  type GetCredentialOptions,
} from '@/lib/credentials';
import type { FetchLike } from './client';

/** Core service_code (proxy 接続情報の格納枠)。config で上書き可能だが既定はこれ。 */
export const DEFAULT_PROXY_SERVICE_CODE = 'yahoo_egress_proxy';

const CACHE_TTL_MS = 5 * 60 * 1000;

interface ProxyCredentials {
  host?: string;
  port?: string | number;
  username?: string;
  password?: string;
}

/** proxy 配線に固有のエラー。message に proxy の値 (host/creds) は載せない。 */
export class YahooEgressProxyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YahooEgressProxyError';
  }
}

interface CachedDispatcher {
  serviceCode: string;
  agent: ProxyAgent;
  at: number;
}
let cached: CachedDispatcher | null = null;

function buildProxyAgent(creds: ProxyCredentials): ProxyAgent {
  const host = typeof creds.host === 'string' ? creds.host.trim() : '';
  const port =
    typeof creds.port === 'number'
      ? String(creds.port)
      : typeof creds.port === 'string'
        ? creds.port.trim()
        : '';
  const username = typeof creds.username === 'string' ? creds.username : '';
  const password = typeof creds.password === 'string' ? creds.password : '';
  if (!host || !port || !username || !password) {
    // 値は載せない (どのフィールドが欠けたかのみ)。
    const missing = [
      !host && 'host',
      !port && 'port',
      !username && 'username',
      !password && 'password',
    ]
      .filter(Boolean)
      .join(',');
    throw new YahooEgressProxyError(
      `yahoo_egress_proxy credential incomplete (missing: ${missing})`,
    );
  }
  // 認証は token(Proxy-Authorization) で渡す。uri には creds を含めない。
  const token = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  return new ProxyAgent({ uri: `http://${host}:${port}`, token });
}

/**
 * Yahoo egress proxy の undici ProxyAgent dispatcher を解決 (5分キャッシュ)。
 * fail-closed: credential 取得不能なら YahooEgressProxyError を throw する。
 *
 * @param serviceCode Core service_code (既定 'yahoo_egress_proxy')。
 * @param opts        getCredential への注入 (テスト用に fetch/CoreURL/鍵を差し替え可)。
 */
export async function getYahooEgressDispatcher(
  serviceCode: string = DEFAULT_PROXY_SERVICE_CODE,
  opts: GetCredentialOptions = {},
): Promise<ProxyAgent> {
  const now = Date.now();
  if (
    cached &&
    cached.serviceCode === serviceCode &&
    now - cached.at < CACHE_TTL_MS &&
    !opts.forceRefresh
  ) {
    return cached.agent;
  }

  let credentials: ProxyCredentials;
  try {
    const resp = await getCredential<ProxyCredentials>(serviceCode, null, opts);
    credentials = (resp.credentials ?? {}) as ProxyCredentials;
  } catch (err) {
    // proxy の値・Core の詳細はログ/メッセージに反射しない (status のみ)。
    const status = err instanceof CredentialFetchError ? err.status : null;
    throw new YahooEgressProxyError(
      `yahoo egress proxy credential unavailable (status=${status ?? 'n/a'})`,
    );
  }

  const agent = buildProxyAgent(credentials);
  cached = { serviceCode, agent, at: now };
  return agent;
}

/**
 * Yahoo egress proxy を経由する FetchLike を返す (YahooTalkClient.fetchImpl に注入する用)。
 * 呼び出しのたびに dispatcher を解決 (キャッシュ済なら即時) し、undici fetch に dispatcher を渡す。
 * proxy 解決失敗時は reject (fail-closed・直 fetch しない)。
 */
export function createYahooProxiedFetch(
  serviceCode: string = DEFAULT_PROXY_SERVICE_CODE,
  opts: GetCredentialOptions = {},
): FetchLike {
  return async (input, init) => {
    const dispatcher = await getYahooEgressDispatcher(serviceCode, opts);
    // undici の fetch は dispatcher オプションを解釈する (global fetch は無視するため明示注入)。
    // undici/global の Response 型差はランタイム互換のため cast で吸収。
    return undiciFetch(input as string, {
      ...(init as Record<string, unknown>),
      dispatcher,
    }) as unknown as Promise<Response>;
  };
}

/** テスト用: dispatcher キャッシュをクリア。 */
export function _clearYahooEgressCacheForTest(): void {
  cached = null;
}
