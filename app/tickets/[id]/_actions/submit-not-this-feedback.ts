'use server';

import { submitNotThisFeedback } from '@/lib/embed/submit-feedback';

/**
 * 〔これじゃない〕送信 Server Action。
 *
 * 認可境界は既存 draft 生成 (generateRagDraft) の Server Action 経路と同一。
 * 鍵 (EMBED_CLIENT_KEY) は submit-feedback (server-only) 内でのみ注入し、ブラウザに一切出さない。
 * 戻り値は安定ラベルのみ (raw/鍵を返さない)。
 */
export async function submitNotThisFeedbackAction(
  runId: string,
  reason: string | null,
): Promise<{ ok: boolean; error?: string }> {
  if (typeof runId !== 'string' || !runId.trim()) {
    return { ok: false, error: 'missing_run_id' };
  }
  const r = await submitNotThisFeedback({
    runId: runId.trim(),
    reason: typeof reason === 'string' && reason.trim() ? reason.trim() : null,
  });
  return r.ok ? { ok: true } : { ok: false, error: r.reason ?? 'feedback_failed' };
}
