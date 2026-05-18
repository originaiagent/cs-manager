'use server';

import { internalFetch } from '@/lib/auth/internal-fetch';
import type { CreateRecordPayload } from './create-record';

export async function updateRecord(
  id: string,
  payload: Partial<CreateRecordPayload>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await internalFetch(`/api/customer-records/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    const j = (await res.json().catch(() => ({}))) as any;
    if (!res.ok || j.ok !== true) {
      return { ok: false, error: j.error ?? `update failed: ${res.status}` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'network error' };
  }
}
