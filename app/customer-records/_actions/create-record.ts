'use server';

import { internalFetch } from '@/lib/auth/internal-fetch';

export interface CreateRecordPayload {
  product_id?: number | string | null;
  product_name_text: string;
  variation_text?: string | null;
  variation_id?: number | null;
  variation_jan?: string | null;
  recipient_name: string;
  recipient_honorific?: string | null;
  order_number?: string | null;
  order_channel?: string | null;
  action_type: string;
  amazon_gift_amount?: number | string | null;
  reship_tracking?: string | null;
  record_date: string;
  line_account?: string | null;
  memo?: string | null;
  defect_type?: string | null;
  ticket_id?: string | null;
}

export async function createRecord(
  payload: CreateRecordPayload,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const res = await internalFetch('/api/customer-records', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const j = (await res.json().catch(() => ({}))) as any;
    if (!res.ok || j.ok !== true) {
      return { ok: false, error: j.error ?? `create failed: ${res.status}` };
    }
    return { ok: true, id: j.record?.id };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'network error' };
  }
}
