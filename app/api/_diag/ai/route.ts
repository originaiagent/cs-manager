import { NextResponse } from 'next/server';
import { invokeChat } from '@/lib/ai-client';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const result = await invokeChat('ping from cs-manager diag');
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
