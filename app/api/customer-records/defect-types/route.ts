import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import { authorizeInternalApiRoute } from '@/lib/auth/api-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * customer_service_records.defect_type の distinct 値を返す (suggest 用)。
 * 空文字は SQL/挿入時に NULL 化済みのため、where defect_type is not null で十分。
 */
export async function GET(req: NextRequest) {
  const authError = await authorizeInternalApiRoute(req);
  if (authError) return authError;

  const sb = await getSupabaseAdmin();
  const { data, error } = await sb
    .from('customer_service_records')
    .select('defect_type')
    .not('defect_type', 'is', null)
    .order('defect_type', { ascending: true })
    .limit(500);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const items = Array.from(
    new Set((data ?? []).map((r: any) => r.defect_type).filter((x: any) => typeof x === 'string' && x.trim())),
  );
  return NextResponse.json({ ok: true, items });
}
