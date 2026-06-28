import { NextRequest, NextResponse } from 'next/server';
import { authorizeInternalApiRoute } from '@/lib/auth/api-auth';
import { getEntryKeys, fetchWithEntryKeys } from '@/lib/core-entry-keys';

/**
 * 親グループの子バリエーション一覧取得 (PR-EF)。
 * - GET /api/v1/master/product-groups/:id?include=products&productFields=id,product_name,variation,jan_code
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CORE_API_URL = process.env.CORE_API_URL?.replace(/\s+$/, '');

interface CacheEntry {
  ts: number;
  variations: Array<{ id: string; product_name: string; variation: string | null; jan_code: string | null }>;
}
const cache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;

export async function GET(req: NextRequest, { params }: { params: { groupId: string } }) {
  const authError = await authorizeInternalApiRoute(req);
  if (authError) return authError;
  const groupId = params.groupId;
  if (!groupId || !/^\d+$/.test(groupId)) {
    return NextResponse.json({ ok: false, variations: [], error: 'invalid groupId' }, { status: 400 });
  }
  const now = Date.now();
  const cached = cache.get(groupId);
  if (cached && now - cached.ts < TTL_MS) {
    return NextResponse.json({ ok: true, variations: cached.variations, cached: true });
  }
  const entryKeys = getEntryKeys();
  if (!CORE_API_URL || entryKeys.length === 0) {
    return NextResponse.json(
      { ok: false, variations: [], error: 'CORE_API_URL / CORE_CREDENTIAL_KEY not configured' },
      { status: 503 },
    );
  }
  const url = `${CORE_API_URL.replace(/\/$/, '')}/api/v1/master/product-groups/${encodeURIComponent(groupId)}?include=products&productFields=${encodeURIComponent('id,product_name,variation,jan_code')}`;
  try {
    const res = await fetchWithEntryKeys(
      url,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      },
      { entryKeys },
    );
    if (!res.ok) {
      // 非 2xx の body は反射しない (status のみ)。
      try { await res.arrayBuffer(); } catch { /* ignore */ }
      return NextResponse.json({ ok: false, variations: [], error: `Core ${res.status}` }, { status: 502 });
    }
    const data = await res.json();
    const group = data?.data ?? data;
    const arr: any[] = Array.isArray(group?.products) ? group.products : [];
    const variations = arr.map((p) => ({
      id: String(p.id),
      product_name: p.product_name ?? '(no name)',
      variation: p.variation ?? null,
      jan_code: p.jan_code ?? null,
    }));
    cache.set(groupId, { ts: now, variations });
    return NextResponse.json({ ok: true, variations });
  } catch (e: any) {
    return NextResponse.json({ ok: false, variations: [], error: e?.message ?? 'core fetch failed' }, { status: 502 });
  }
}
