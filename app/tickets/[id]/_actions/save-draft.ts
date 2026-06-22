'use server';

import { internalFetch } from '@/lib/auth/internal-fetch';

export interface SaveDraftResult {
  ok: boolean;
  error?: string;
}

/**
 * Ticket 下書き保存 Server Action。
 *
 * /api/tickets/[id]/drafts は X-Internal-API-Key 必須化されているため、
 * ブラウザからは直接 fetch せず本 Server Action 経由で呼ぶ。
 */
export async function saveDraft(
  ticketId: string,
  body: string,
  source: 'manual' | 'ai_draft' | 'rag',
  opts?: { is_separated?: boolean },
): Promise<SaveDraftResult> {
  try {
    const res = await internalFetch(
      `/api/tickets/${encodeURIComponent(ticketId)}/drafts`,
      {
        method: 'POST',
        // is_separated は指定時のみ送る (manual は既定 false のまま)。
        // AI 由来 (ai_draft/rag) は呼び出し側が顧客向け本文のみで true を渡す契約。
        body: JSON.stringify(
          opts?.is_separated === undefined
            ? { body, source }
            : { body, source, is_separated: opts.is_separated },
        ),
      },
    );
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error: (typeof j.error === 'string' && j.error) || `save failed: ${res.status}`,
      };
    }
    return { ok: true };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `network error: ${msg}` };
  }
}
