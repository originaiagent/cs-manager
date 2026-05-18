'use server';

import { internalFetch } from '@/lib/auth/internal-fetch';

export async function updateArticle(
  id: string,
  payload: any,
): Promise<{ ok: boolean; error?: string; article?: any }> {
  try {
    const res = await internalFetch(
      `/api/knowledge/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(payload),
      },
    );
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || !j.ok) {
      return {
        ok: false,
        error:
          (typeof j.error === 'string' && j.error) || `update failed: ${res.status}`,
      };
    }
    return { ok: true, article: (j as any).article };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `network error: ${msg}` };
  }
}
