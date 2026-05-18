import { NextRequest, NextResponse } from 'next/server';
import { invokeChat } from '@/lib/ai-client';
import { authorizeApiRoute } from '@/lib/auth/api-auth';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const authError = authorizeApiRoute(req, { tier: 'diag' });
  if (authError) return authError;

  try {
    const result = await invokeChat('ping from cs-manager diag');
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error?.message ?? String(error) }, { status: 500 });
  }
}
