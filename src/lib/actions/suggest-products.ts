'use server';

import { internalFetch } from '@/lib/auth/internal-fetch';

export async function suggestProducts(
  q: string,
): Promise<{
  ok: boolean;
  items?: Array<{ id: string; product_name: string; variation?: string | null }>;
  error?: string;
}> {
  try {
    const res = await internalFetch(
      `/api/products/suggest?q=${encodeURIComponent(q)}`,
      { method: 'GET' },
    );
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || !j.ok) {
      return {
        ok: false,
        error:
          (typeof j.error === 'string' && j.error) || `suggest failed: ${res.status}`,
      };
    }
    return { ok: true, items: (j as any).items ?? [] };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `network error: ${msg}` };
  }
}
