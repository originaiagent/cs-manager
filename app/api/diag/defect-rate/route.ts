/**
 * 不良率集計の本番検証口 — N+1/429 事故の再発防止
 *
 * GET /api/diag/defect-rate?period=30d&granularity=parent&basis=occurred
 * (不良率ページと同一クエリパラメータ。データ取得・集計も同一ローダ loadDefectRateData を共用)
 *
 * 背景: 本番の /quality/defect-rate は OIDC ユーザーゲート内にあり curl で検証できないため、
 * ローカル検証で代用した結果「本番だけ不良数が全製品 0」を見逃した。本ルートは同じ集計の
 * **数字だけ**を返し、本番で機械的に裏を取れるようにする。
 *
 * 認可: 既存 /api/diag/* と同一 (X-Diag-Token: $DIAG_TOKEN)。認可なしの公開はしない。
 * PII: 製品名・注文番号・顧客情報・原因ラベルは返さない (件数と真偽値のみ)。
 */

import { NextRequest, NextResponse } from 'next/server';
import { authorizeApiRoute } from '@/lib/auth/api-auth';
import { loadDefectRateData } from '@/lib/quality/defect-rate-data';
import { withCoreRequestCount } from '@/lib/core-entry-keys';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  const authError = authorizeApiRoute(req, { tier: 'diag' });
  if (authError) return authError;

  const sp = req.nextUrl.searchParams;
  const startedAt = Date.now();

  try {
    // Core 呼び出し回数を計測 (N+1 退行の本番検出。ceil(N/500) 前後に収まるのが正常)
    const { result: data, coreRequests } = await withCoreRequestCount(() =>
      loadDefectRateData({
        period: sp.get('period') ?? undefined,
        month: sp.get('month') ?? undefined,
        granularity: sp.get('granularity') ?? undefined,
        from: sp.get('from') ?? undefined,
        to: sp.get('to') ?? undefined,
        basis: sp.get('basis') ?? undefined,
      }),
    );

    let totalCases = 0;
    let salesUnitsTotal = 0;
    for (const row of data.rows) {
      totalCases += row.total_cases;
      salesUnitsTotal += row.sales_units ?? 0;
    }

    return NextResponse.json({
      ok: true,
      range: { start: data.range.start, end: data.range.end },
      granularity: data.granularity,
      basis: data.basis,
      rows: data.rows.length,
      totalCases,
      salesUnitsTotal,
      salesOk: data.salesOk,
      returnsOk: data.returnsOk,
      returnsTruncated: data.returnsTruncated,
      unclassifiedReturns: data.unclassifiedReturns,
      returnsWithSymptoms: data.returnsWithSymptoms,
      asinResolutionDegraded: data.asinResolutionDegraded,
      amazonLookupFailed: data.amazonLookupFailed,
      orderLinkedOrders: data.orderLinkedOrders,
      orderAmbiguousOrders: data.orderAmbiguousOrders,
      orderProductsDegraded: data.orderProductsDegraded,
      unmapped: data.agg.unmapped,
      orderedFallbackCases: data.agg.orderedFallbackCases,
      coreRequests,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (error: any) {
    // エラー本文は内部情報を含み得るため message のみ (PII/鍵は載せない)
    return NextResponse.json(
      { ok: false, error: error?.message ?? String(error), elapsedMs: Date.now() - startedAt },
      { status: 500 },
    );
  }
}
