import { NextRequest, NextResponse } from 'next/server';
import { fetchProducts } from '@/lib/core-client';

export const dynamic = 'force-dynamic';

function authorize(req: NextRequest): NextResponse | null {
  const required = process.env.DIAG_TOKEN;
  if (!required) {
    return NextResponse.json({ ok: false, error: 'DIAG_TOKEN is not set on server' }, { status: 500 });
  }
  const provided = req.headers.get('x-diag-token');
  if (provided !== required) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

export async function GET(req: NextRequest) {
  const authError = authorize(req);
  if (authError) return authError;

  try {
    const result = await fetchProducts(1);
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error?.message ?? String(error) }, { status: 500 });
  }
}
