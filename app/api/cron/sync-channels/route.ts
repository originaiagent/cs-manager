import { NextRequest, NextResponse } from 'next/server';
import { runChannelSync } from '@/lib/sync/orchestrator';
import { authorizeApiRoute } from '@/lib/auth/api-auth';

export const dynamic = 'force-dynamic';
// 取込ジョブはやや時間がかかる可能性があるため Node ランタイムを明示
export const runtime = 'nodejs';
export const maxDuration = 300; // 5 min（Vercel Hobby 上限まで）

/**
 * 認可: tier='cron' (Authorization: Bearer ${CRON_SECRET} または X-Diag-Token: ${DIAG_TOKEN})
 */
export async function GET(req: NextRequest) {
  const authError = authorizeApiRoute(req, { tier: 'cron' });
  if (authError) return authError;

  try {
    const result = await runChannelSync();
    const hasError = result.channels.some((c) => c.error);
    return NextResponse.json({ ok: !hasError, result }, { status: hasError ? 207 : 200 });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message ?? String(err) },
      { status: 500 },
    );
  }
}

// 任意で POST も許可（curl での手動トリガ用）
export const POST = GET;
