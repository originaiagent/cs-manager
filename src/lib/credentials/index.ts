/**
 * Core 経由の外部サービス credential 取得ラッパー
 *
 * 設計レビュー: Gemini APPROVE (2026-05-07)
 *
 * - エンドポイント: GET ${CORE_API_URL}/api/credentials/:service_code?scope_key=...&as_of=...
 * - 認証: X-Internal-API-Key (process.env.INTERNAL_API_KEY)
 * - キャッシュ: プロセス内 Map (TTL 5 分)。Vercel Functions のコールドスタートで失効する想定で OK
 * - cs-manager 内に楽天等の鍵類は持たない (env も含めて)
 */
// CORE_API_URL / INTERNAL_API_KEY は call-time に解決する (module-init 固定にしない)。
// 本番では env は静的なため挙動不変。テスト/複数 import 時の env 上書き順序に依存しないため。
function envCoreApiUrl(): string | undefined {
  return process.env.CORE_API_URL?.replace(/\s+$/, '');
}
function envInternalApiKey(): string | undefined {
  return process.env.INTERNAL_API_KEY?.replace(/\s+$/, '');
}
const CORE_API_TIMEOUT_MS = process.env.CORE_API_TIMEOUT_MS
  ? parseInt(process.env.CORE_API_TIMEOUT_MS, 10)
  : 10_000;

const CACHE_TTL_MS = 5 * 60 * 1000;
// Gemini code review Medium 指摘: 長寿命プロセス (テスト常駐 / 仮想 dev server 等)
// で scope_key 数 = キャッシュサイズが線形に増えないよう、最大サイズで FIFO 風に古い
// エントリを破棄する単純な防御策を入れる。Vercel Functions では本来コールドスタート
// で全消去されるため過剰なリスクは無いが、ガード代わり。
const CACHE_MAX_ENTRIES = 256;

export interface CredentialResponse<T = Record<string, unknown>> {
  service_code: string;
  scope_key: string | null;
  label?: string | null;
  credentials: T;
  metadata: Record<string, unknown>;
  valid_from: string;
  valid_to: string | null;
}

interface CacheEntry {
  fetchedAt: number;
  value: CredentialResponse;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(serviceCode: string, scopeKey: string | null): string {
  return `${serviceCode}::${scopeKey ?? ''}`;
}

export interface GetCredentialOptions {
  /** テスト時に fetch を差し替える */
  fetchImpl?: typeof fetch;
  /** テスト時に CORE_API_URL を上書き (空文字で「未設定」状態を再現可) */
  coreApiUrl?: string;
  /** テスト時に INTERNAL_API_KEY を上書き (空文字で「未設定」状態を再現可) */
  internalApiKey?: string;
  /** キャッシュをバイパスして再取得 */
  forceRefresh?: boolean;
}

export class CredentialFetchError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly serviceCode: string,
    public readonly scopeKey: string | null,
  ) {
    super(message);
    this.name = 'CredentialFetchError';
  }
}

/**
 * Core から credential を取得する。
 * 5 分以内の前回取得結果がキャッシュされていればそれを返す。
 *
 * - 401/404/500 は CredentialFetchError として throw する。caller (cron 等) で捕捉して再試行に回す。
 * - 環境変数 (CORE_API_URL / INTERNAL_API_KEY) 未設定時も throw。
 */
export async function getCredential<T = Record<string, unknown>>(
  serviceCode: string,
  scopeKey: string | null = null,
  opts: GetCredentialOptions = {},
): Promise<CredentialResponse<T>> {
  const coreUrl = opts.coreApiUrl ?? envCoreApiUrl();
  const apiKey = opts.internalApiKey ?? envInternalApiKey();
  if (!coreUrl) {
    throw new CredentialFetchError('CORE_API_URL is not set', null, serviceCode, scopeKey);
  }
  if (!apiKey) {
    throw new CredentialFetchError(
      'INTERNAL_API_KEY is not set',
      null,
      serviceCode,
      scopeKey,
    );
  }

  const key = cacheKey(serviceCode, scopeKey);
  if (!opts.forceRefresh) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
      return hit.value as CredentialResponse<T>;
    }
  }

  const fetchFn = opts.fetchImpl ?? fetch;
  const url = new URL(
    `${coreUrl.replace(/\/$/, '')}/api/credentials/${encodeURIComponent(serviceCode)}`,
  );
  if (scopeKey) url.searchParams.set('scope_key', scopeKey);

  let res: Response;
  try {
    res = await fetchFn(url.toString(), {
      method: 'GET',
      headers: {
        'X-Internal-API-Key': apiKey,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(CORE_API_TIMEOUT_MS),
    });
  } catch (err: any) {
    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new CredentialFetchError(
      isTimeout
        ? `Timeout after ${CORE_API_TIMEOUT_MS}ms`
        : `Network error: ${err?.message ?? String(err)}`,
      null,
      serviceCode,
      scopeKey,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new CredentialFetchError(
      `Core ${res.status} ${res.statusText}: ${text.slice(0, 300)}`,
      res.status,
      serviceCode,
      scopeKey,
    );
  }

  const body = (await res.json()) as CredentialResponse<T>;
  // FIFO 風の LRU 簡易実装: max を超えたら最古を削除 (Map の挿入順を利用)
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  // キャッシュは型を消した上で保管 (取り出し時に caller の T で再キャスト)
  cache.set(key, { fetchedAt: Date.now(), value: body as unknown as CredentialResponse });
  return body;
}

/**
 * 複数 credential を並列に取得する (Vercel Function のコールドスタート時のレイテンシ低減)。
 */
export async function getCredentialsParallel<T = Record<string, unknown>>(
  requests: Array<{ serviceCode: string; scopeKey?: string | null }>,
  opts: GetCredentialOptions = {},
): Promise<Array<CredentialResponse<T>>> {
  return Promise.all(
    requests.map((r) => getCredential<T>(r.serviceCode, r.scopeKey ?? null, opts)),
  );
}

/** テスト用: キャッシュ全クリア */
export function _clearCredentialCacheForTest(): void {
  cache.clear();
}
