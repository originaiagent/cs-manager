'use server';

import { internalFetch } from '@/lib/auth/internal-fetch';

/**
 * 親グループの子バリエーション取得 Server Action (PR-EF)。
 */
export async function fetchVariations(groupId: string): Promise<{
  ok: boolean;
  variations?: Array<{ id: string; product_name: string; variation: string | null; jan_code: string | null }>;
  error?: string;
}> {
  try {
    const res = await internalFetch(`/api/products/group/${encodeURIComponent(groupId)}/variations`, { method: 'GET' });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || !j.ok) {
      return { ok: false, error: (typeof j.error === 'string' && j.error) || `fetch failed: ${res.status}` };
    }
    return { ok: true, variations: (j as any).variations ?? [] };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
