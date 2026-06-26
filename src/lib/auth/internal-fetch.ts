import { getInboundVerifyKeys } from '@/lib/credentials';

/**
 * Server Action 専用の内部 fetch ヘルパ。
 * 必ず Server Action / Server Component / API Route からのみ import すること
 * (Core 経由で共有内部鍵を解決するため server-only)。
 * 自分自身の /api/* に対して X-Internal-API-Key を付与して呼び出す。
 *
 * 接続鍵 Core 集約 Done-1: 署名鍵は env INTERNAL_API_KEY 直読みを廃止し、
 * Core service_code='core_internal_shared' 取得値 (getInboundVerifyKeys()[0]) を使う。
 * 検証側 (authorizeInternalApiRoute) も同 Core 値で照合するため両端で同値が成立する。
 * 鍵未解決 (Core 未到達かつ stale 失効) 時は throw (鍵なしで自 API を叩かない = fail-closed)。
 *
 * host 解決順 (Host header 由来 SSRF を防ぐ):
 *   1. process.env.APP_BASE_URL (本番: 明示設定推奨)
 *   2. process.env.VERCEL_URL (Vercel が自動付与)
 *   3. dev 環境のみ http://localhost:3000 (NODE_ENV !== 'production')
 *
 * いずれにも該当しない場合は throw する (Host ヘッダは信用しない)。
 */
export async function internalFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const [apiKey] = await getInboundVerifyKeys();
  if (!apiKey) throw new Error('shared internal key is unavailable (Core core_internal_shared)');
  if (!path.startsWith('/')) throw new Error('path must start with /');

  const base = resolveBaseUrl();
  const url = `${base}${path}`;

  const headers = new Headers(init?.headers);
  headers.set('X-Internal-API-Key', apiKey);
  if (init?.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  return fetch(url, { ...init, headers, cache: 'no-store' });
}

function resolveBaseUrl(): string {
  const appBaseRaw = process.env.APP_BASE_URL?.trim();
  if (appBaseRaw) {
    const u = appBaseRaw.replace(/\/$/, '');
    // production で localhost を弾く (codex R2 注記: 空白混入も trim 済)
    if (process.env.NODE_ENV === 'production' && /^https?:\/\/localhost(?::\d+)?$/i.test(u)) {
      throw new Error('APP_BASE_URL must not be localhost in production');
    }
    return u;
  }

  const vercelRaw = process.env.VERCEL_URL?.trim();
  if (vercelRaw) {
    const u = vercelRaw.replace(/\/$/, '');
    return u.startsWith('http') ? u : `https://${u}`;
  }

  if (process.env.NODE_ENV !== 'production') return 'http://localhost:3000';

  throw new Error('No trusted base URL: set APP_BASE_URL or VERCEL_URL');
}
