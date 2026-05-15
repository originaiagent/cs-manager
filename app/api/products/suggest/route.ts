import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CORE_API_URL = process.env.CORE_API_URL?.replace(/\s+$/, '');
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY?.replace(/\s+$/, '');

interface CacheEntry {
  ts: number;
  items: Array<{ id: string; product_name: string; variation?: string | null }>;
}
const cache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q')?.trim() ?? '';
  if (!q) return NextResponse.json({ ok: true, items: [] });

  const cached = cache.get(q);
  const now = Date.now();
  if (cached && now - cached.ts < TTL_MS) {
    return NextResponse.json({ ok: true, items: cached.items, cached: true });
  }

  if (!CORE_API_URL || !INTERNAL_API_KEY) {
    return NextResponse.json(
      { ok: false, items: [], error: 'CORE_API_URL / INTERNAL_API_KEY not configured' },
      { status: 503 },
    );
  }

  // Core: /api/v1/master/products?q= が無ければ全件取得 → クライアント側で部分一致 (ガワ妥協)
  // Core が q=... をサポートしていない場合に備え、limit=300 で取得して部分一致をする
  const url = `${CORE_API_URL.replace(/\/$/, '')}/api/v1/master/products?limit=300`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Internal-API-Key': INTERNAL_API_KEY,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, items: [], error: `Core ${res.status}` },
        { status: 502 },
      );
    }
    const data = await res.json();
    const all: Array<any> = Array.isArray(data) ? data : data.data ?? data.products ?? [];
    const ql = q.toLowerCase();
    const items = all
      .filter((p) => {
        const name = String(p?.product_name ?? '').toLowerCase();
        const variation = String(p?.variation ?? '').toLowerCase();
        const idStr = String(p?.id ?? '').toLowerCase();
        return name.includes(ql) || variation.includes(ql) || idStr === ql;
      })
      .slice(0, 10)
      .map((p) => ({
        id: String(p.id),
        product_name: p.product_name ?? '(no name)',
        variation: p.variation ?? null,
      }));
    cache.set(q, { ts: now, items });
    return NextResponse.json({ ok: true, items });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, items: [], error: e?.message ?? 'core fetch failed' },
      { status: 502 },
    );
  }
}
