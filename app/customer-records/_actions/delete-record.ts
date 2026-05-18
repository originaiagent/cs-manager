'use server';

import { internalFetch } from '@/lib/auth/internal-fetch';

export async function deleteRecord(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await internalFetch(`/api/customer-records/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    const j = (await res.json().catch(() => ({}))) as any;
    if (!res.ok || j.ok !== true) {
      return { ok: false, error: j.error ?? `delete failed: ${res.status}` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'network error' };
  }
}
