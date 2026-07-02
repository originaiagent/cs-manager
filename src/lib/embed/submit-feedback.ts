/**
 * 〔これじゃない〕フィードバック送信 (cs-manager サーバ側・単一入口)。
 *
 * origin-ai embed facade の feedback 口 (POST /api/embed/feedback) を叩く唯一の関数。
 * 契約(SoT)は origin-ai 側 (dashboard/lib/feedback/contract.ts) に定義され、cs-manager は
 * その endpoint/payload に準拠する薄い writer を持つ (v1。横展開時は npm 化: dev_backlog)。
 *
 * 不変条件 (run-oneshot.ts と同じ fail-closed / 鍵安全):
 *   - 認証 = per-tool embed key (X-Embed-Key)。EMBED_CLIENT_KEY は **サーバ側 env のみ**。
 *     レスポンス/ブラウザ/ログへ一切露出しない。鍵未配布 → fail。
 *   - reason は origin-ai 側でマスク/staff-gate される。cs-manager 側ではログに出さない (種別のみ)。
 *   - 安定ラベル (reason) のみ返す。stack / env / raw は出さない。
 */

// server-only 相当 (cf. run-oneshot): クライアントへバンドルされたら即時 throw。
if (typeof window !== 'undefined') {
  throw new Error('submit-feedback.ts is server-only and must not be imported in the browser');
}

// 〔これじゃない〕送信の transport / contract は **@originaiagent/feedback が SoT**。
// cs-manager は薄写しを撤去し、endpoint/payload/reason 正規化を package に委譲する
// (createEmbedFeedbackSubmit は同一 fetch 形 + AbortSignal timeout + 安定ラベルを提供)。
import { createEmbedFeedbackSubmit } from '@originaiagent/feedback/server';
import { normalizeReason } from '@originaiagent/feedback';

export interface SubmitFeedbackResult {
  ok: boolean;
  /** 失敗時の PII-safe 安定ラベル。 */
  reason?: string;
}

/**
 * 〔これじゃない〕を origin-ai へ送信する。run_id = ai_embed_runs.id。
 * 200 → ok:true。それ以外 → ok:false + 安定ラベル。鍵/raw は返さない。
 * 鍵未配布 (key/baseUrl 未設定) → fail-closed (embed_key_unprovisioned)。
 */
export async function submitNotThisFeedback(args: {
  runId: string;
  reason: string | null;
}): Promise<SubmitFeedbackResult> {
  const key = process.env.EMBED_CLIENT_KEY?.replace(/\s+$/, '');
  const baseUrl = process.env.ORIGIN_AI_BASE_URL?.replace(/\s+$/, '').replace(/\/$/, '');
  if (!key || !baseUrl) {
    return { ok: false, reason: 'embed_key_unprovisioned' };
  }
  if (!args.runId) {
    return { ok: false, reason: 'missing_run_id' };
  }

  const submit = createEmbedFeedbackSubmit({
    baseUrl,
    authHeaders: { 'X-Embed-Key': key },
  });
  const r = await submit({
    run_id: args.runId,
    verdict: 'not_this',
    reason: normalizeReason(args.reason),
  });
  return r.ok ? { ok: true } : { ok: false, reason: r.error ?? 'feedback_request_failed' };
}
