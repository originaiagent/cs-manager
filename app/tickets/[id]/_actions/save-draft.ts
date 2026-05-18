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
  source: 'manual' | 'ai_draft',
): Promise<SaveDraftResult> {
  try {
    const res = await internalFetch(
      `/api/tickets/${encodeURIComponent(ticketId)}/drafts`,
      {
        method: 'POST',
        body: JSON.stringify({ body, source }),
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
