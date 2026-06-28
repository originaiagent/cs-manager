import { NextRequest, NextResponse } from 'next/server';
import { authorizeInternalApiRoute } from '@/lib/auth/api-auth';
import { getEntryKeys, fetchWithEntryKeys } from '@/lib/core-entry-keys';

/**
 * 親グループ検索エンドポイント (PR-EF: Core 親子構造に厳密準拠)。
 *
 * - Core GET /api/v1/master/product-groups?q=<term>&limit=500&fields=id,group_name,developer
 * - 上位 LIMIT=20 を返す
 * - Core が q を honor 前提だが防御で local filter
 * - shape 防御 (Array / data / products)
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CORE_API_URL = process.env.CORE_API_URL?.replace(/\s+$/, '');

interface CacheEntry {
  ts: number;
  items: Array<{ id: string; group_name: string; developer: string | null }>;
}
const cache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;
const LIMIT = 20;            // 候補表示の上限
const FETCH_LIMIT = 500;     // Core が q を honor しない環境への防御: 大きめに取得して local filter
const FIELDS = 'id,group_name,developer';

export async function GET(req: NextRequest) {
  const authError = await authorizeInternalApiRoute(req);
  if (authError) return authError;

  const q = req.nextUrl.searchParams.get('q')?.trim() ?? '';
  if (!q) return NextResponse.json({ ok: true, items: [] });

  // cache key: q + limit + fields (将来変更耐性)
  const cacheKey = `${q}|${LIMIT}|${FIELDS}`;
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached && now - cached.ts < TTL_MS) {
    return NextResponse.json({ ok: true, items: cached.items, cached: true });
  }

  const entryKeys = getEntryKeys();
  if (!CORE_API_URL || entryKeys.length === 0) {
    return NextResponse.json(
      { ok: false, items: [], error: 'CORE_API_URL / CORE_CREDENTIAL_KEY not configured' },
      { status: 503 },
    );
  }

  const url = `${CORE_API_URL.replace(/\/$/, '')}/api/v1/master/product-groups?q=${encodeURIComponent(q)}&limit=${FETCH_LIMIT}&fields=${encodeURIComponent(FIELDS)}`;
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
      return NextResponse.json(
        { ok: false, items: [], error: `Core ${res.status}` },
        { status: 502 },
      );
    }
    const data = await res.json();
    const arr: any[] = Array.isArray(data)
      ? data
      : (data?.data ?? data?.products ?? []);
    // Core が q= を honor しない環境への防御: ローカルでも部分一致フィルタを通す
    const ql = q.toLowerCase();
    const items = arr
      .filter((p) => {
        const name = String(p?.group_name ?? '').toLowerCase();
        const developer = String(p?.developer ?? '').toLowerCase();
        const idStr = String(p?.id ?? '').toLowerCase();
        return name.includes(ql) || developer.includes(ql) || idStr === ql;
      })
      .slice(0, LIMIT)
      .map((p) => ({
        id: String(p.id),
        group_name: p.group_name ?? '(no name)',
        developer: p.developer ?? null,
      }));
    cache.set(cacheKey, { ts: now, items });
    return NextResponse.json({ ok: true, items });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, items: [], error: e?.message ?? 'core fetch failed' },
      { status: 502 },
    );
  }
}
