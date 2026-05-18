'use server';

import { internalFetch } from '@/lib/auth/internal-fetch';

export interface GenerateAiDraftResult {
  ok: boolean;
  draft?: string;
  durationMs?: number;
  skillUsed?: string | null;
  error?: string;
}

/**
 * AI ドラフト生成 Server Action。
 *
 * /api/tickets/[id]/draft-ai は X-Internal-API-Key 必須化されているため、
 * ブラウザから直接 fetch せず、本 Server Action 経由で呼ぶ。
 *
 * 鍵注入と base URL 解決は internalFetch に集約 (Host header 由来 SSRF 防止)。
 */
export async function generateAiDraft(
  ticketId: string,
): Promise<GenerateAiDraftResult> {
  try {
    const res = await internalFetch(
      `/api/tickets/${encodeURIComponent(ticketId)}/draft-ai`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || j.ok !== true) {
      return {
        ok: false,
        error:
          (typeof j.error === 'string' && j.error) ||
          `AI generation failed: ${res.status}`,
      };
    }
    return {
      ok: true,
      draft: typeof j.draft === 'string' ? j.draft : '',
      durationMs: typeof j.durationMs === 'number' ? j.durationMs : undefined,
      skillUsed: (j.skillUsed as string | null | undefined) ?? null,
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `network error: ${msg}` };
  }
}
