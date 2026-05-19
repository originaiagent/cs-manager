'use server';

import { internalFetch } from '@/lib/auth/internal-fetch';

export async function deleteArticle(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await internalFetch(
      `/api/knowledge/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || j.ok !== true) {
      return {
        ok: false,
        error:
          (typeof j.error === 'string' && j.error) || `delete failed: ${res.status}`,
      };
    }
    return { ok: true };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `network error: ${msg}` };
  }
}
