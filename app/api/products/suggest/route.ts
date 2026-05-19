import { NextRequest, NextResponse } from 'next/server';
import { authorizeApiRoute } from '@/lib/auth/api-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CORE_API_URL = process.env.CORE_API_URL?.replace(/\s+$/, '');
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY?.replace(/\s+$/, '');

interface CacheEntry {
  ts: number;
  items: Array<{ id: string; product_name: string; variation: string | null }>;
}
const cache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;
const LIMIT = 20;
const FIELDS = 'id,product_name,variation';

export async function GET(req: NextRequest) {
  const authError = authorizeApiRoute(req, { tier: 'internal' });
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

  if (!CORE_API_URL || !INTERNAL_API_KEY) {
    return NextResponse.json(
      { ok: false, items: [], error: 'CORE_API_URL / INTERNAL_API_KEY not configured' },
      { status: 503 },
    );
  }

  const url = `${CORE_API_URL.replace(/\/$/, '')}/api/v1/master/products?q=${encodeURIComponent(q)}&limit=${LIMIT}&fields=${encodeURIComponent(FIELDS)}`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'X-Internal-API-Key': INTERNAL_API_KEY, Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, items: [], error: `Core ${res.status}` },
        { status: 502 },
      );
    }
    const data = await res.json();
    const arr: any[] = data?.data ?? [];
    const items = arr.map((p) => ({
      id: String(p.id),
      product_name: p.product_name ?? '(no name)',
      variation: p.variation ?? null,
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
