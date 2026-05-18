'use server';

import { internalFetch } from '@/lib/auth/internal-fetch';

export interface UpdateTicketStatusResult {
  ok: boolean;
  error?: string;
}

/**
 * Ticket ステータス更新 Server Action。
 *
 * /api/tickets/[id] は X-Internal-API-Key 必須化されているため、
 * ブラウザからは直接 fetch せず本 Server Action 経由で呼ぶ。
 */
export async function updateTicketStatus(
  ticketId: string,
  status: 'untouched' | 'in_progress' | 'done',
): Promise<UpdateTicketStatusResult> {
  try {
    const res = await internalFetch(`/api/tickets/${encodeURIComponent(ticketId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error: (typeof j.error === 'string' && j.error) || `update failed: ${res.status}`,
      };
    }
    return { ok: true };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `network error: ${msg}` };
  }
}
