import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import { authorizeApiRoute } from '@/lib/auth/api-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_STATUS = ['untouched', 'in_progress', 'done'] as const;

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const authError = authorizeApiRoute(req, { tier: 'internal' });
  if (authError) return authError;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const status = body?.status;
  if (typeof status !== 'string' || !ALLOWED_STATUS.includes(status as any)) {
    return NextResponse.json(
      { error: `status must be one of ${ALLOWED_STATUS.join(', ')}` },
      { status: 400 },
    );
  }

  const sb = await getSupabaseAdmin();
  const update: Record<string, any> = { status };
  if (status === 'done') update.resolved_at = new Date().toISOString();
  else update.resolved_at = null;

  const { data, error } = await sb
    .from('tickets')
    .update(update)
    .eq('id', params.id)
    .select('id, status, resolved_at')
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'ticket not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true, ticket: data });
}
