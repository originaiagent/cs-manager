import { NextResponse } from 'next/server';
import { fetchProducts } from '@/lib/core-client';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const result = await fetchProducts(1);
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
