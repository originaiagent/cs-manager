import { NextRequest, NextResponse } from 'next/server';
import { runChannelSync } from '@/lib/sync/orchestrator';

export const dynamic = 'force-dynamic';
// 取込ジョブはやや時間がかかる可能性があるため Node ランタイムを明示
export const runtime = 'nodejs';
export const maxDuration = 300; // 5 min（Vercel Hobby 上限まで）

/**
 * 認可:
 *  - Vercel Cron は `Authorization: Bearer ${CRON_SECRET}` を自動付与する
 *  - 手動デバッグ実行用に X-Diag-Token: ${DIAG_TOKEN} も許可
 *  - いずれも一致しなければ 401
 */
function authorize(req: NextRequest): NextResponse | null {
  const cronSecret = process.env.CRON_SECRET;
  const diagToken = process.env.DIAG_TOKEN;

  const authHeader = req.headers.get('authorization');
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) return null;

  const provided = req.headers.get('x-diag-token');
  if (diagToken && provided === diagToken) return null;

  return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
}

export async function GET(req: NextRequest) {
  const authError = authorize(req);
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
