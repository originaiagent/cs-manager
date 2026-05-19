import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import { authorizeApiRoute } from '@/lib/auth/api-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_SCOPES = ['company', 'store', 'product'] as const;
const ALLOWED_STATUSES = ['draft', 'published'] as const;

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const authError = authorizeApiRoute(req, { tier: 'internal' });
  if (authError) return authError;
  const sb = await getSupabaseAdmin();
  const { data, error } = await sb
    .from('knowledge_articles')
    .select('*')
    .eq('id', params.id)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true, article: data });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const authError = authorizeApiRoute(req, { tier: 'internal' });
  if (authError) return authError;
  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }

  const update: Record<string, any> = {};
  if ('title' in payload) update.title = payload.title;
  if ('question' in payload) update.question = payload.question;
  if ('answer' in payload) update.answer = payload.answer;
  if ('body_markdown' in payload) update.body_markdown = payload.body_markdown;
  if ('tags' in payload) update.tags = payload.tags ?? [];
  if ('applies_to_stores' in payload) update.applies_to_stores = payload.applies_to_stores ?? [];
  if ('applies_to_products' in payload) update.applies_to_products = payload.applies_to_products ?? [];
  if ('applies_to_categories' in payload) update.applies_to_categories = payload.applies_to_categories ?? [];
  if ('applies_to_defect_types' in payload) update.applies_to_defect_types = payload.applies_to_defect_types ?? [];
  if ('status' in payload) {
    if (!ALLOWED_STATUSES.includes(payload.status)) {
      return NextResponse.json({ ok: false, error: 'invalid status' }, { status: 400 });
    }
    update.status = payload.status;
  }
  if ('storage_scope' in payload) {
    if (!ALLOWED_SCOPES.includes(payload.storage_scope)) {
      return NextResponse.json({ ok: false, error: 'invalid storage_scope' }, { status: 400 });
    }
    update.storage_scope = payload.storage_scope;
    update.storage_store_id = payload.storage_scope === 'store' ? payload.storage_store_id : null;
    update.storage_product_id = payload.storage_scope === 'product' ? payload.storage_product_id : null;
  }

  const sb = await getSupabaseAdmin();
  const { data, error } = await sb
    .from('knowledge_articles')
    .update(update)
    .eq('id', params.id)
    .is('deleted_at', null)
    .select('*')
    .maybeSingle();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true, article: data });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const authError = authorizeApiRoute(req, { tier: 'internal' });
  if (authError) return authError;
  const sb = await getSupabaseAdmin();
  const { data, error } = await sb
    .from('knowledge_articles')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', params.id)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
