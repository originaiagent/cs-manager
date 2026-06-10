'use server';

import { internalFetch } from '@/lib/auth/internal-fetch';

/**
 * 実需 work `oneshot:inquiry-to-customer-record` の入口 Server Action。
 *
 * 問い合わせ (ticket) を起点に、origin-ai の oneshot work を起動して
 * 顧客対応記録 (customer_record) のドラフトを抽出させる。
 *
 * - クライアントから target_id を素通ししない: ticketId はサーバ側で受け取り
 *   そのまま target_id として渡す (route 側で存在確認 + target_type guard)。
 * - EMBED_CLIENT_KEY は /api/embed-run 内 (server-only env) でのみ参照され、
 *   この Server Action / ブラウザには露出しない。
 * - X-Internal-API-Key は internalFetch が server-only env から付与する。
 */
export async function runInquiryToRecord(
  ticketId: string,
): Promise<{ ok: boolean; run_id?: string; result?: unknown; error?: string }> {
  if (!ticketId || typeof ticketId !== 'string') {
    return { ok: false, error: 'ticket_id is required' };
  }
  try {
    const res = await internalFetch('/api/embed-run', {
      method: 'POST',
      body: JSON.stringify({ target_type: 'customer_record', target_id: ticketId }),
    });
    const j = (await res.json().catch(() => ({}))) as any;
    if (res.status === 503) {
      return { ok: false, error: 'AI 連携キー未配布のため、現在この機能は利用できません' };
    }
    if (!res.ok || j.ok !== true) {
      return { ok: false, error: j.error ?? j.reason ?? `run failed: ${res.status}` };
    }
    return { ok: true, run_id: j.run_id, result: j.result ?? null };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'network error' };
  }
}
