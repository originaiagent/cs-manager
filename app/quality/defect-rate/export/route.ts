/**
 * 不良エビデンス CSV エクスポート — 工場エビデンス化 C3b-3
 *
 * GET /quality/defect-rate/export?period=&month=&granularity=&from=&to=&view=&basis=
 * (不良率ページと同一クエリパラメータ。データ取得・集計も同一ローダを共用)
 *
 * 認可: このルートは /api/* ではないため middleware.ts の USER ゲート対象
 * (PUBLIC_PATHS = ['/login', '/api'] に該当せず、matcher は静的アセット以外の全パスを
 * カバーする)。NEXT_PUBLIC_CORE_AUTH_ENABLED=true の本番ではログイン済み +
 * tool_access['cs-manager'] のユーザーのみダウンロードできる。フラグ OFF 時に
 * 素通りになるのは全ページ共通の現行挙動 (ページと同じ扱い)。
 *
 * PII: 明細は案件×原因のみで、顧客名・メールアドレス・問い合わせ本文は含めない。
 */

import type { NextRequest } from 'next/server';
import { loadDefectRateData } from '@/lib/quality/defect-rate-data';
import {
  buildDefectEvidenceCsv,
  type DefectEvidenceCsvRow,
} from '@/lib/quality/defect-evidence-csv';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;

/** Excel が UTF-8 と認識するための BOM (明細本文は builder が生成) */
const UTF8_BOM = '\ufeff';

export async function GET(req: NextRequest): Promise<Response> {
  const sp = req.nextUrl.searchParams;
  const data = await loadDefectRateData({
    period: sp.get('period') ?? undefined,
    month: sp.get('month') ?? undefined,
    granularity: sp.get('granularity') ?? undefined,
    from: sp.get('from') ?? undefined,
    to: sp.get('to') ?? undefined,
    view: sp.get('view') ?? undefined,
    basis: sp.get('basis') ?? undefined,
  });

  const csvRows: DefectEvidenceCsvRow[] = data.rows.map((row) => ({
    row,
    productName: data.productNameOf(row.group_id),
    // 親粒度はバリエーション列を空にする (親行は案件のバリエーション情報を持たない)
    variationLabel: data.granularity === 'variation' ? data.variationLabelOf(row) : '',
  }));
  const csv = buildDefectEvidenceCsv({
    rows: csvRows,
    view: data.view,
    basis: data.basis,
  });

  const filename = `defect-evidence_${data.range.start}_${data.range.end}_${data.view}.csv`;
  return new Response(UTF8_BOM + csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
