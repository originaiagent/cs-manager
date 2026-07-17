/**
 * Core 入口鍵 (tool→Core の X-Internal-API-Key) の解決とリトライ helper。
 *
 * 接続鍵 Core 集約 (origin-core #332)。代表ツール ys-staff-tool の確定パターンを複製。
 *
 * 設計:
 *   - entry 鍵: per-tool scoped 入口鍵 CORE_CREDENTIAL_KEY のみを使う。
 *     Done-1 最終化済 (2026-06-26 codex APPROVE): 移行期の global INTERNAL_API_KEY retry
 *     fallback は除去した。scoped 鍵の Core grant (core_internal_shared / origin_ai_internal /
 *     originai_oauth / supabase_service_role / rakuten_rmesse / line_messaging / yahoo_shopping +
 *     api:internal:read) を完備し、本番 Core-switch を検証済。
 *   - 候補は trim・空除外する。
 *   - 401/403 のみ次鍵 retry (候補 1 本のため実質 retry は発生しないが helper の汎用性は維持)。
 *     network/timeout は鍵差し替えで解決しないため即 throw。
 *   - 非 2xx の body は呼出元へ反射しない (secret/内部情報の反射防止)。status のみ扱う。
 *   - 鍵値はログに出力しない。
 *
 * 流量制御 (不良率 0 件事故の再発防止):
 *   - 本 helper を通る全 Core リクエストにプロセス内セマフォ (既定 6 並列) を掛ける。
 *     1 ページ描画で数百リクエストを無制限並列に投げると Core が 429 を返し、
 *     どの解決が落ちるかがランダムになる (= 不良数が 0 件になる事故の原因)。
 *   - 429/503 は指数バックオフで最大 2 回リトライ (Retry-After があれば優先・上限 5 秒)。
 *   - 呼出側シグネチャは不変 (透過的に効く)。
 *
 * 設計レビュー: codex APPROVE (2026-06-25 staged / 2026-06-26 Done-1 最終化)。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * entry 鍵候補を返す。per-tool scoped 入口鍵 CORE_CREDENTIAL_KEY のみ (Done-1 最終化:
 * 旧 global INTERNAL_API_KEY fallback は除去)。trim・空除外済み。
 */
export function getEntryKeys(): string[] {
  const scoped = process.env.CORE_CREDENTIAL_KEY?.replace(/\s+$/, '');
  return scoped ? [scoped] : [];
}

export interface FetchWithEntryKeysOptions {
  /** テスト時に fetch を差し替える */
  fetchImpl?: typeof fetch;
  /**
   * entry 鍵を上書きする (テスト/特定 caller 用)。未指定時は getEntryKeys()。
   * 空配列を渡した場合は呼出側で「鍵未設定」エラーを扱うこと (本 helper は throw する)。
   */
  entryKeys?: string[];
}

// ---------------------------------------------------------------------------
// 流量制御: 同時実行セマフォ + 429/503 リトライ
// ---------------------------------------------------------------------------

/** Core への同時リクエスト数の既定上限 (env CORE_MAX_CONCURRENCY で可変) */
const DEFAULT_MAX_CONCURRENCY = 6;

/** バックオフ再試行の対象 status (混雑・一時不可のみ。他の非 2xx は即返し) */
const RETRYABLE_STATUSES = new Set([429, 503]);

/** 再試行の基準待機 (ms)。要素数 = 最大リトライ回数 */
const RETRY_BASE_DELAYS_MS = [300, 900];

/** Retry-After を尊重する際の上限 (Core が長い値を返してもここで頭打ち) */
const RETRY_AFTER_CAP_MS = 5_000;

/** env は call-time 解決 (テスト時の env 上書き順序に依存しないため) */
function maxConcurrency(): number {
  const raw = process.env.CORE_MAX_CONCURRENCY;
  const n = raw != null ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_CONCURRENCY;
}

let activeRequests = 0;
const waiters: Array<() => void> = [];

/** セマフォ獲得。上限に達している間は release まで待つ (上限は wake 毎に再評価) */
async function acquireSlot(): Promise<void> {
  while (activeRequests >= maxConcurrency()) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  activeRequests++;
}

function releaseSlot(): void {
  activeRequests = Math.max(0, activeRequests - 1);
  waiters.shift()?.();
}

/**
 * 当該リクエスト中の Core 呼び出し回数カウンタ (診断用)。
 * AsyncLocalStorage のため、並行する別リクエストの回数は混ざらない。
 */
const coreRequestCounter = new AsyncLocalStorage<{ count: number }>();

/**
 * fn 実行中に本 helper 経由で発行された Core リクエスト数を数える (診断口 /api/diag/defect-rate 用)。
 * 計測対象は実際に送出した HTTP リクエスト (鍵 retry・バックオフ再試行も 1 回として数える)。
 */
export async function withCoreRequestCount<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; coreRequests: number }> {
  const store = { count: 0 };
  const result = await coreRequestCounter.run(store, fn);
  return { result, coreRequests: store.count };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 再試行までの待機 ms。Retry-After (秒 or HTTP-date) があれば優先し RETRY_AFTER_CAP_MS で頭打ち。
 * 無ければ基準待機 + jitter (同時に落ちた複数リクエストの再突入を散らす)。
 */
function retryDelayMs(res: Response, attempt: number): number {
  const base = RETRY_BASE_DELAYS_MS[attempt] ?? RETRY_BASE_DELAYS_MS[RETRY_BASE_DELAYS_MS.length - 1];
  const header = res.headers.get('retry-after');
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs) && secs >= 0) {
      return Math.min(secs * 1000, RETRY_AFTER_CAP_MS);
    }
    const at = Date.parse(header);
    if (Number.isFinite(at)) {
      return Math.min(Math.max(at - Date.now(), 0), RETRY_AFTER_CAP_MS);
    }
  }
  return base + Math.floor(Math.random() * base * 0.3);
}

/**
 * X-Internal-API-Key を entry 鍵候補で順試行する fetch。
 *
 * - 各鍵で fetch し、401/403 かつ次鍵がある場合のみ次鍵で retry。
 * - res.ok もしくは「401/403 以外の非 2xx (=鍵差し替えで解決しない応答)」を得たら
 *   その Response を返す (body は呼出側で扱う / status のみ反射する設計は呼出側責務)。
 * - network/timeout (fetch reject) は即 throw (鍵差し替えで解決しない)。
 * - 全鍵で 401/403 の場合は最後の Response を返す (呼出側で status を扱う)。
 * - 同時実行はセマフォ (既定 6 並列) で制限し、429/503 は最大 2 回までバックオフ再試行する。
 *   待機中はセマフォ枠を解放する (再試行待ちが他のリクエストを塞がないため)。
 *
 * @param url     リクエスト先 URL。
 * @param init    fetch init。headers は base として使い、X-Internal-API-Key を鍵ごとに上書き付与。
 *                body 付きリクエストは事前に buffer 済みの値 (ArrayBuffer/string) を渡し、retry 再利用すること。
 * @param opts    fetchImpl / entryKeys の上書き。
 */
export async function fetchWithEntryKeys(
  url: string,
  init: RequestInit,
  opts: FetchWithEntryKeysOptions = {},
): Promise<Response> {
  const entryKeys = opts.entryKeys ?? getEntryKeys();
  if (entryKeys.length === 0) {
    throw new Error(
      '[core-entry-keys] CORE_CREDENTIAL_KEY が未設定です (Core API 認証に必須)',
    );
  }
  const fetchFn = opts.fetchImpl ?? fetch;
  const baseHeaders = new Headers(init.headers);

  for (let attempt = 0; ; attempt++) {
    const res = await tryEntryKeys(url, init, baseHeaders, entryKeys, fetchFn);
    // 429/503 以外、またはリトライ上限到達ならそのまま返す。
    if (!RETRYABLE_STATUSES.has(res.status) || attempt >= RETRY_BASE_DELAYS_MS.length) {
      return res;
    }
    const waitMs = retryDelayMs(res, attempt);
    // body を読み捨ててから再試行 (反射しない・接続を解放)。
    try {
      await res.arrayBuffer();
    } catch {
      /* ignore */
    }
    await sleep(waitMs);
  }
}

/**
 * entry 鍵候補を 1 巡する (セマフォ 1 枠を保持したまま)。
 * fetchWithEntryKeys の 1 attempt 分に相当。
 */
async function tryEntryKeys(
  url: string,
  init: RequestInit,
  baseHeaders: Headers,
  entryKeys: string[],
  fetchFn: typeof fetch,
): Promise<Response> {
  await acquireSlot();
  try {
    let last: Response | null = null;
    for (let i = 0; i < entryKeys.length; i++) {
      const headers = new Headers(baseHeaders);
      headers.set('X-Internal-API-Key', entryKeys[i]);
      const counter = coreRequestCounter.getStore();
      if (counter) counter.count++;
      // network/timeout は鍵差し替えで解決しないため catch せず即 throw に伝播させる。
      const res = await fetchFn(url, { ...init, headers });
      if (res.ok) return res;
      // 401/403 で次の entry 鍵があれば retry (Done-1 後は候補 1 本のため通常発生しない)。
      if ((res.status === 401 || res.status === 403) && i < entryKeys.length - 1) {
        // body を読み捨ててから次鍵へ (反射しない・接続を解放)。
        try {
          await res.arrayBuffer();
        } catch {
          /* ignore */
        }
        last = res;
        continue;
      }
      return res;
    }
    // 全鍵 401/403。最後の Response を返す (呼出側で status を扱う)。
    // last は必ず非 null (ループは最低 1 回 entry 鍵を試行する)。
    return last as Response;
  } finally {
    releaseSlot();
  }
}
