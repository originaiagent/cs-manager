'use server';

import { headers } from 'next/headers';

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
 * 鍵は process.env.INTERNAL_API_KEY (server only)。クライアントには絶対露出しない。
 *
 * Vercel 上では二段関数呼び出し (Server Action lambda → API Route lambda) になるが、
 * AI 集約原則 + 単一のルート責務維持のため許容 (Gemini APPROVE 2026-05-11)。
 */
export async function generateAiDraft(
  ticketId: string,
): Promise<GenerateAiDraftResult> {
  const apiKey = process.env.INTERNAL_API_KEY?.replace(/\s+$/, '');
  if (!apiKey) {
    return { ok: false, error: 'INTERNAL_API_KEY is not configured' };
  }

  const h = headers();
  const host = h.get('host');
  if (!host) {
    return { ok: false, error: 'host header missing' };
  }
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  const url = `${proto}://${host}/api/tickets/${encodeURIComponent(ticketId)}/draft-ai`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-API-Key': apiKey,
      },
      body: JSON.stringify({}),
      cache: 'no-store',
    });
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
