import { NextRequest, NextResponse } from 'next/server';
import { runDefectClassification } from '@/lib/quality/defect-classify';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import { authorizeApiRoute } from '@/lib/auth/api-auth';

export const dynamic = 'force-dynamic';
// AI 分類 (mask + chat) は時間がかかるため Node ランタイム + 上限 5 分
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * 不良分類 cron (15 分間隔) — tickets.case_category 自動付与 + 不良原因抽出
 *
 * 対象: case_category is null かつ classify_attempts < 3 のチケットを古い順に
 * 最大 20 件 (env DEFECT_CLASSIFY_BATCH_LIMIT で可変)。詳細は
 * src/lib/quality/defect-classify.ts (PII 不変条件: 外部へは masked のみ)。
 *
 * 認可: `Authorization: Bearer ${CRON_SECRET}` または `X-Diag-Token: ${DIAG_TOKEN}`
 * (既存 cron と同パターン)。レスポンスは処理件数のみ (PII を含めない)。
 */
export async function GET(req: NextRequest) {
  const authError = authorizeApiRoute(req, { tier: 'cron' });
  if (authError) return authError;

  const startedAt = new Date();
  try {
    const sb = await getSupabaseAdmin();
    const result = await runDefectClassification(sb);
    return NextResponse.json({
      ok: true,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      result,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message ?? String(err) },
      { status: 500 },
    );
  }
}

// 手動トリガ (curl) 用に POST も許可
export const POST = GET;
