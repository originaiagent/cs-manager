/**
 * Core 経由の外部サービス credential 取得ラッパー
 *
 * 設計レビュー: Gemini APPROVE (2026-05-07) / 接続鍵 Core 集約 Done-1 codex APPROVE (2026-06-26)
 *
 * - エンドポイント: GET ${CORE_API_URL}/api/credentials/:service_code?scope_key=...&as_of=...
 * - 認証: X-Internal-API-Key。entry 鍵は per-tool scoped 入口鍵 CORE_CREDENTIAL_KEY のみ
 *   (Done-1 最終化: 旧 global INTERNAL_API_KEY fallback は除去)。詳細は core-entry-keys.ts。
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
  /** テスト時に scoped 入口鍵 (CORE_CREDENTIAL_KEY) を上書き (空文字で「未設定」状態を再現可) */
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
 * - 環境変数 (CORE_API_URL / CORE_CREDENTIAL_KEY) 未設定時も throw。
 */
export async function getCredential<T = Record<string, unknown>>(
  serviceCode: string,
  scopeKey: string | null = null,
  opts: GetCredentialOptions = {},
): Promise<CredentialResponse<T>> {
  const coreUrl = opts.coreApiUrl ?? envCoreApiUrl();
  // entry 鍵: per-tool scoped 入口鍵 CORE_CREDENTIAL_KEY のみ (Done-1 最終化: global fallback 除去)。
  // テストは opts.internalApiKey で単一鍵注入可。
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
      'CORE_CREDENTIAL_KEY is not set',
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
 * inbound / self-loop 検証用の共有内部鍵 (core_internal_shared) を Core から取得する。
 *
 * origin-core が本ツールの /api/ai/manifest・/api/ai/capabilities/* を叩く際、および
 * 本ツール自身の Server Action が internalFetch で自分の /api/* を叩く際に送る
 * X-Internal-API-Key の正本値を Core から取得する。
 * service_code='core_internal_shared'(field api_key・全ツール共通値・scoped 入口鍵とは別物)。
 *
 * Done-1 最終化済: env INTERNAL_API_KEY / INTERNAL_API_KEY_NEW 候補は除去した。
 * 共有鍵は Core (scoped 入口鍵 CORE_CREDENTIAL_KEY の core_internal_shared grant 経由) のみから取得する。
 * 耐障害性: getCredential は 5 分 positive TTL。さらに直近成功値を STALE_MAX(60分)まで保持し、
 * Core の **一時障害(network/timeout/5xx)時のみ** stale 値で inbound を継続する(stale-while-error)。
 * 認証/grant失効/credential削除(4xx)や api_key 不在は stale を使わず即 fail-closed(失効鍵を受理し続けない)。
 * 候補空なら呼出側で fail-closed(401)。値・失敗理由は出さない。呼出側は全候補を定数時間比較すること。
 *
 * 接続鍵 Core 集約 (origin-core #332) / Done-1。
 */
const INBOUND_STALE_MAX_MS = 60 * 60 * 1000;
let inboundLastGood: { value: string; at: number } | null = null;

/**
 * core_internal_shared(全ツール共通の正本内部鍵)を Core から取得する共通内部関数。
 * stale-while-error は **transient 障害のみ** に限定する:
 *   transient = network/timeout(status=null) または Core 5xx → 直近成功値(STALE_MAX=60分以内)で継続。
 *   非 transient = 401/403/404 等 4xx(認証/grant 失効/credential 削除) や api_key 不在 → null
 *     (失効/revoked 鍵を最大60分受理し続ける security regression を防ぐ)。値・理由はログに出さない。
 */
async function fetchSharedInternalKey(): Promise<string | null> {
  try {
    const cred = await getCredential<{ api_key?: unknown }>('core_internal_shared');
    const v = cred.credentials?.api_key;
    if (typeof v === 'string') {
      const trimmed = v.replace(/\s+$/, '');
      if (trimmed.length > 0) {
        inboundLastGood = { value: trimmed, at: Date.now() };
        return trimmed;
      }
    }
    // 200 だが api_key 不在/空 = 意図的削除/設定不備。last-good を破棄し fail-closed
    // (後続の transient 障害で失効値が stale 復活しないようにする)。
    inboundLastGood = null;
    return null;
  } catch (err) {
    const status = err instanceof CredentialFetchError ? err.status : null;
    const isTransient = status === null || status >= 500;
    if (!isTransient) {
      // 非 transient(401/403/404 等 4xx=認証/grant 失効/credential 削除=revocation)。
      // last-good を破棄し即 fail-closed。以降の transient 障害でも失効鍵を復活させない。
      inboundLastGood = null;
      return null;
    }
    // transient(network/timeout=status null, または 5xx)のみ stale-while-error。
    if (inboundLastGood && Date.now() - inboundLastGood.at < INBOUND_STALE_MAX_MS) {
      return inboundLastGood.value;
    }
    return null;
  }
}

/**
 * inbound / self-loop 検証用の照合候補 (Core core_internal_shared 1 件 or 0 件) を返す。
 * 呼出側は候補を短絡なしで定数時間比較し、候補空なら fail-closed すること。
 */
export async function getInboundVerifyKeys(): Promise<string[]> {
  const v = await fetchSharedInternalKey();
  return v ? [v] : [];
}

/**
 * outbound: origin-ai の embed MCP validate コールバック等で送出する共有内部鍵を返す。
 *
 * EMBED_MCP_VALIDATE_KEY が設定済なら専用 embed 検証鍵を優先する(carve-out)。
 * 無ければ Core core_internal_shared(全ツール共通の正本・origin-ai validate が受理する値)を返す。
 * いずれも無ければ null(呼出側は鍵なしで送出せず fail-closed すること)。値はログに出さない。
 * Done-1: 旧 global env INTERNAL_API_KEY 直読みは廃止し、共有鍵は Core 経由で解決する。
 */
export async function getSharedInternalApiKey(): Promise<string | null> {
  const embed = process.env.EMBED_MCP_VALIDATE_KEY?.trim();
  if (embed) return embed;
  return fetchSharedInternalKey();
}

/** テスト用: キャッシュ全クリア (positive cache + inbound stale-while-error の last-good) */
export function _clearCredentialCacheForTest(): void {
  cache.clear();
  inboundLastGood = null;
}

/**
 * テスト用: getCredential の positive cache のみクリア (inbound の last-good は保持)。
 * 本番で 5 分 TTL が失効した状況 (= stale-while-error が効く状況) を再現するために使う。
 */
export function _clearPositiveCacheForTest(): void {
  cache.clear();
}
