import { NextRequest, NextResponse } from 'next/server';
import { runReturnCommentClassification } from '@/lib/quality/return-comment-classify';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import { authorizeApiRoute } from '@/lib/auth/api-auth';

export const dynamic = 'force-dynamic';
// AI 分類 (ec-manager 取得 + mask + chat) は時間がかかるため Node ランタイム + 上限 5 分
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * FBA返品 顧客コメント症状分類 cron (30 分間隔) — fba_return_symptoms 抽出
 *
 * 対象: 直近ウィンドウ (RETURN_COMMENT_WINDOW_DAYS) の FBA 返品のうち customerComments が
 * 非空の行を、原子的クレーム RPC (claim_fba_return_classify_batch) 経由で最大 20 件処理する。
 * 詳細は src/lib/quality/return-comment-classify.ts (PII 不変条件: 外部へは masked のみ、
 * 顧客コメント原文はどのテーブル・ログにも保存しない)。
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
    const result = await runReturnCommentClassification(sb);
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
