import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_SCOPES = ['company', 'store', 'product'] as const;
const ALLOWED_STATUSES = ['draft', 'published', 'archived'] as const;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const sb = getSupabaseAdmin();
  let q = sb
    .from('knowledge_articles')
    .select('*');
  const scope = sp.get('scope');
  if (scope && ALLOWED_SCOPES.includes(scope as any)) q = q.eq('storage_scope', scope);
  const status = sp.get('status');
  if (status && ALLOWED_STATUSES.includes(status as any)) q = q.eq('status', status);
  const store = sp.get('store');
  if (store) q = q.contains('applies_to_stores', [store]);
  const product = sp.get('product');
  if (product) q = q.contains('applies_to_products', [product]);
  const text = sp.get('q');
  if (text && text.trim()) {
    const pat = `%${text.trim()}%`;
    q = q.or(`title.ilike.${pat},question.ilike.${pat},answer.ilike.${pat}`);
  }
  q = q.order('updated_at', { ascending: false }).limit(200);
  const { data, error } = await q;
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, articles: data });
}

export async function POST(req: NextRequest) {
  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }
  if (!payload?.title) {
    return NextResponse.json({ ok: false, error: 'title required' }, { status: 400 });
  }
  if (!ALLOWED_SCOPES.includes(payload.storage_scope)) {
    return NextResponse.json({ ok: false, error: 'invalid storage_scope' }, { status: 400 });
  }
  if (payload.storage_scope === 'store' && !payload.storage_store_id) {
    return NextResponse.json({ ok: false, error: 'storage_store_id required for store scope' }, { status: 400 });
  }
  if (payload.storage_scope === 'product' && !payload.storage_product_id) {
    return NextResponse.json({ ok: false, error: 'storage_product_id required for product scope' }, { status: 400 });
  }
  const sb = getSupabaseAdmin();
  const insert = {
    storage_scope: payload.storage_scope,
    storage_store_id: payload.storage_scope === 'store' ? payload.storage_store_id : null,
    storage_product_id: payload.storage_scope === 'product' ? payload.storage_product_id : null,
    applies_to_stores: payload.applies_to_stores ?? [],
    applies_to_products: payload.applies_to_products ?? [],
    applies_to_categories: payload.applies_to_categories ?? [],
    applies_to_defect_types: payload.applies_to_defect_types ?? [],
    title: payload.title,
    question: payload.question ?? null,
    answer: payload.answer ?? null,
    body_markdown: payload.body_markdown ?? null,
    tags: payload.tags ?? [],
    status: payload.status ?? 'draft',
  };
  const { data, error } = await sb
    .from('knowledge_articles')
    .insert(insert)
    .select('*')
    .single();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, article: data });
}
