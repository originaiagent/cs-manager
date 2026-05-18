import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import { authorizeApiRoute } from '@/lib/auth/api-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_STATUSES = ['draft', 'in_review', 'accepted', 'rejected', 'escalated'] as const;

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const authError = authorizeApiRoute(req, { tier: 'internal' });
  if (authError) return authError;
  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }
  if (!ALLOWED_STATUSES.includes(payload?.status)) {
    return NextResponse.json(
      { ok: false, error: `status must be one of ${ALLOWED_STATUSES.join(', ')}` },
      { status: 400 },
    );
  }
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from('product_improvement_proposals')
    .update({ status: payload.status })
    .eq('id', params.id)
    .select('id, status')
    .maybeSingle();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true, proposal: data });
}
