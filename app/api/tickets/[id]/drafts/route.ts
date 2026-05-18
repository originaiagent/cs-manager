import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import { authorizeApiRoute } from '@/lib/auth/api-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_SOURCES = ['manual', 'ai_draft'] as const;

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const authError = authorizeApiRoute(req, { tier: 'internal' });
  if (authError) return authError;
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from('ticket_drafts')
    .select('id, body, source, created_at, updated_at')
    .eq('ticket_id', params.id)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, draft: data });
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const authError = authorizeApiRoute(req, { tier: 'internal' });
  if (authError) return authError;
  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const body = payload?.body;
  const source = payload?.source ?? 'manual';
  if (typeof body !== 'string' || !body.trim()) {
    return NextResponse.json({ error: 'body is required' }, { status: 400 });
  }
  if (!ALLOWED_SOURCES.includes(source)) {
    return NextResponse.json(
      { error: `source must be one of ${ALLOWED_SOURCES.join(', ')}` },
      { status: 400 },
    );
  }

  const sb = getSupabaseAdmin();

  // ticket 存在確認
  const { data: ticket } = await sb
    .from('tickets')
    .select('id')
    .eq('id', params.id)
    .maybeSingle();
  if (!ticket) {
    return NextResponse.json({ error: 'ticket not found' }, { status: 404 });
  }

  const { data, error } = await sb
    .from('ticket_drafts')
    .insert({ ticket_id: params.id, body, source })
    .select('id, body, source, created_at')
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, draft: data });
}
