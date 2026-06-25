/**
 * Core 経由の外部サービス credential 取得ラッパー
 *
 * 設計レビュー: Gemini APPROVE (2026-05-07)
 *
 * - エンドポイント: GET ${CORE_API_URL}/api/credentials/:service_code?scope_key=...&as_of=...
 * - 認証: X-Internal-API-Key。entry 鍵は CORE_CREDENTIAL_KEY(scoped, 優先) → INTERNAL_API_KEY(global)
 *   を順試行し、401/403 で次鍵へ retry する (接続鍵 Core 集約 staged rollout)。詳細は core-entry-keys.ts。
 * - キャッシュ: プロセス内 Map (TTL 5 分)。Vercel Functions のコールドスタートで失効する想定で OK
 * - cs-manager 内に楽天等の鍵類は持たない (env も含めて)
 */
import { getEntryKeys, fetchWithEntryKeys } from '@/lib/core-entry-keys';

// CORE_API_URL / INTERNAL_API_KEY は call-time に解決する (module-init 固定にしない)。
// 本番では env は静的なため挙動不変。テスト/複数 import 時の env 上書き順序に依存しないため。
function envCoreApiUrl(): string | undefined {
  return process.env.CORE_API_URL?.replace(/\s+$/, '');
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
  // entry 鍵: scoped (CORE_CREDENTIAL_KEY) 優先・global (INTERNAL_API_KEY) fallback を順試行し
  // 401/403 で次鍵へ retry する (staged rollout 安全)。テストは opts.internalApiKey で単一鍵注入可。
  const entryKeys =
    opts.internalApiKey !== undefined
      ? opts.internalApiKey
        ? [opts.internalApiKey]
        : []
      : getEntryKeys();
  if (!coreUrl) {
    throw new CredentialFetchError('CORE_API_URL is not set', null, serviceCode, scopeKey);
  }
  if (entryKeys.length === 0) {
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

  // entry 鍵を順試行し 401/403 で次鍵 retry。network/timeout は即 throw。
  let res: Response;
  try {
    res = await fetchWithEntryKeys(
      url.toString(),
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(CORE_API_TIMEOUT_MS),
      },
      { fetchImpl: fetchFn, entryKeys },
    );
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
    // 非 2xx の body は呼出元へ反射しない (secret/内部情報の反射防止)。status のみ扱う。
    try {
      await res.arrayBuffer();
    } catch {
      /* ignore */
    }
    throw new CredentialFetchError(
      `Core ${res.status} ${res.statusText}`,
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

/**
 * inbound 検証用の共有内部鍵の照合候補を返す。
 *
 * origin-core が本ツールの /api/ai/manifest・/api/ai/capabilities/* 等を叩く際に送る
 * X-Internal-API-Key の正本値 (= 旧 global INTERNAL_API_KEY) を Core から取得する。
 * service_code='core_internal_shared'(全ツール共通値・scoped 入口鍵とは別物)。
 *
 * 移行期は env INTERNAL_API_KEY / INTERNAL_API_KEY_NEW も候補に含める (Phase5 で除去)。
 * Core 未登録/未到達時も env fallback で継続する (fail-open しない: 候補が空なら呼出側で 401)。
 * 値・取得失敗理由はログに出さない。呼出側は定数時間比較すること。
 *
 * 接続鍵 Core 集約 (origin-core #332)。代表ツール ys-staff-tool の getInboundVerifyKeys と同型。
 */
export async function getInboundVerifyKeys(): Promise<string[]> {
  const keys: string[] = [];
  try {
    const cred = await getCredential<{ api_key?: string }>('core_internal_shared');
    const v = cred.credentials?.api_key?.replace(/\s+$/, '');
    if (v) keys.push(v);
  } catch {
    // Core 未登録/未到達は移行期 env fallback のみで継続。値・理由は出さない。
  }
  const envOld = process.env.INTERNAL_API_KEY?.replace(/\s+$/, '');
  const envNew = process.env.INTERNAL_API_KEY_NEW?.replace(/\s+$/, '');
  // 重複除外しつつ追加。
  for (const v of [envOld, envNew]) {
    if (v && !keys.includes(v)) keys.push(v);
  }
  return keys;
}

/** テスト用: キャッシュ全クリア */
export function _clearCredentialCacheForTest(): void {
  cache.clear();
}
