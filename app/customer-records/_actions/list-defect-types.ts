'use server';

import { internalFetch } from '@/lib/auth/internal-fetch';

export async function listDefectTypes(): Promise<{ ok: boolean; items?: string[]; error?: string }> {
  try {
    const res = await internalFetch('/api/customer-records/defect-types', { method: 'GET' });
    const j = (await res.json().catch(() => ({}))) as any;
    if (!res.ok || j.ok !== true) {
      return { ok: false, error: j.error ?? `fetch failed: ${res.status}` };
    }
    return { ok: true, items: Array.isArray(j.items) ? j.items : [] };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'network error' };
  }
}
