/**
 * origin-ai embed 窓口の oneshot 起動 + ポーリング (cs-manager サーバ側・単一入口)。
 *
 * 設計レビュー: codex APPROVE (2026-06-24)。cs-manager は自前の LLM 呼出・検索クエリ生成・
 *   プロンプト直書きを持たず、業務 AI は **すべて** origin-ai の embed 作業 (oneshot) へ委譲する。
 *   本ヘルパは「POST /api/embed/run → GET /api/embed/runs/{id} を completed までポーリング」だけを行う。
 *
 * 不変条件 (fail-closed / PII 安全):
 *   - 認証 = per-tool embed key (X-Embed-Key)。EMBED_CLIENT_KEY は **サーバ側 env のみ**。
 *     レスポンス/ブラウザ/ログへ一切露出しない。鍵未配布 (key/baseUrl 未設定) → fail。
 *   - 非同期: /api/embed/run は 202 queued を返す。result は runs ポーリングで取得する
 *     (gemma 生成は数十秒。タイムアウトで切らないよう deadline=150s, transient retry)。
 *   - エラーは安定ラベル (reason) のみ返す。stack / env / raw input / run 本文を出さない。
 *   - server-only: クライアントバンドル混入を防ぐためモジュール先頭で window を弾く
 *     (`server-only` パッケージ非導入のため runtime guard で相当を担保)。
 */

// server-only 相当 (cf. codex): クライアントへバンドルされたら即時 throw。
if (typeof window !== 'undefined') {
  throw new Error('run-oneshot.ts is server-only and must not be imported in the browser');
}

export interface EmbedOneshotResult {
  ok: boolean;
  /** completed 時の run result (origin-ai oneshot の公開契約出力)。 */
  result?: Record<string, unknown>;
  /** 失敗時の PII-safe 安定ラベル (run_id/status 種別のみ。raw を含めない)。 */
  reason?: string;
}

export interface RunEmbedOneshotArgs {
  /** bare oneshot slug (例 'cs-reply:draft')。'oneshot:' prefix は付けない。 */
  slug: string;
  /** embed クライアントの allowed_target_types に含まれる値 (例 'customer_record')。 */
  targetType: string;
  /** 対象エンティティ id (例 ticket UUID)。サーバ側で実在を保証した値を渡すこと。 */
  targetId: string;
  /** oneshot への入力。origin-ai 側 skill の input_text_keys / lookup args で消費される。 */
  input: Record<string, unknown>;
}

const POLL_DEADLINE_MS = 150_000;

// poll 間隔は既定 2s。テスト時のみ EMBED_RUN_POLL_INTERVAL_MS で短縮 (本番未設定=2s)。
function pollIntervalMs(): number {
  return Number(process.env.EMBED_RUN_POLL_INTERVAL_MS) || 2000;
}

/**
 * origin-ai /api/embed/run (oneshot) を起動し completed までポーリングして result を返す。
 * 失敗時は ok:false + 安定 reason ラベル。raw / 鍵 / stack は一切返さない。
 */
export async function runEmbedOneshotAndPoll(
  args: RunEmbedOneshotArgs,
): Promise<EmbedOneshotResult> {
  const key = process.env.EMBED_CLIENT_KEY?.replace(/\s+$/, '');
  const baseUrl = process.env.ORIGIN_AI_BASE_URL?.replace(/\s+$/, '').replace(/\/$/, '');
  if (!key || !baseUrl) {
    // 鍵未配布 → fail-closed (UI は「未配布キー待ち」相当)。
    return { ok: false, reason: 'embed_key_unprovisioned' };
  }

  // 1. POST /api/embed/run (202 queued 期待)。
  let runId: string | undefined;
  try {
    const runResp = await fetch(`${baseUrl}/api/embed/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Embed-Key': key },
      body: JSON.stringify({
        kind: 'oneshot',
        slug: args.slug,
        target_type: args.targetType,
        target_id: args.targetId,
        mode: 'auto',
        input: args.input,
      }),
      cache: 'no-store',
    });
    if (runResp.status !== 202) {
      return { ok: false, reason: `embed_run_start_${runResp.status}` };
    }
    const j = (await runResp.json().catch(() => ({}))) as { run_id?: string };
    runId = typeof j.run_id === 'string' ? j.run_id : undefined;
  } catch {
    return { ok: false, reason: 'embed_run_start_failed' };
  }
  if (!runId) {
    return { ok: false, reason: 'embed_run_no_run_id' };
  }

  // 2. poll GET /api/embed/runs/{run_id} until completed/failed/deadline。
  const deadline = Date.now() + POLL_DEADLINE_MS;
  let notFound = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs()));
    let pollResp: Response;
    try {
      pollResp = await fetch(`${baseUrl}/api/embed/runs/${runId}`, {
        headers: { 'X-Embed-Key': key },
        cache: 'no-store',
      });
    } catch {
      continue; // transient network → retry until deadline
    }
    if (pollResp.status === 404) {
      // 書込直後の伝播遅延を許容 (>3 回連続で確定 not-found)。
      if (++notFound > 3) return { ok: false, reason: 'embed_run_not_found' };
      continue;
    }
    // transient: 408 / 429 / 5xx は deadline まで retry。
    if (pollResp.status === 408 || pollResp.status === 429 || pollResp.status >= 500) {
      continue;
    }
    if (!pollResp.ok) {
      return { ok: false, reason: `embed_run_poll_${pollResp.status}` };
    }
    let json: { status?: string; result?: unknown };
    try {
      json = (await pollResp.json()) as { status?: string; result?: unknown };
    } catch {
      continue;
    }
    if (json.status === 'completed') {
      const result =
        json.result && typeof json.result === 'object'
          ? (json.result as Record<string, unknown>)
          : null;
      if (!result) return { ok: false, reason: 'embed_run_empty_result' };
      return { ok: true, result };
    }
    if (json.status === 'failed' || json.status === 'cancelled') {
      return { ok: false, reason: `embed_run_${json.status}` };
    }
    // running / queued → continue
  }
  return { ok: false, reason: 'embed_run_poll_deadline' };
}
