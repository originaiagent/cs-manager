'use server';

import { internalFetch } from '@/lib/auth/internal-fetch';

export type ProposalKind = 'improvement-suggestion' | 'product-proposal';

export async function updateProposalStatus(
  kind: ProposalKind,
  id: string,
  status: string,
): Promise<{ ok: boolean; error?: string }> {
  const path = kind === 'improvement-suggestion'
    ? `/api/improvement-suggestions/${encodeURIComponent(id)}`
    : `/api/product-proposals/${encodeURIComponent(id)}`;
  try {
    const res = await internalFetch(path, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
    const j = await res.json().catch(() => ({} as any));
    if (!res.ok) return { ok: false, error: (typeof j.error === 'string' && j.error) || `update failed: ${res.status}` };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'network error' };
  }
}
