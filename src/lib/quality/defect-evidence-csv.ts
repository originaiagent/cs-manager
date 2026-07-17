/**
 * 不良エビデンス CSV 生成 — 工場エビデンス化 C3b-3 (純関数・vitest 対象)
 *
 * 1 行 = 1 案件 × 1 原因 (工場側でピボット集計できる形)。原因が 1 件も無い案件も
 * 1 行出す (原因列は空。案件を黙って落とさない)。
 * 顧客名・メールアドレス・問い合わせ本文などの PII は一切含めない
 * (案件詳細はリンク先の画面で見る)。サマリ (製品毎の販売数・率) は CSV に混ぜず
 * 明細のみとする (Excel 互換優先。画面 + 定義パネルで補完)。
 *
 * BOM はここでは付けない (route 側で先頭に付与)。改行は Excel 互換の CRLF。
 */

import {
  MAJOR_CATEGORY_LABELS,
  RESPONSIBILITY_LABELS,
} from './defect-taxonomy';
import type { DefectAggRow, DefectBasis } from './defect-aggregate';
import {
  filterCasesByView,
  caseRouteLabel,
  caseBasisDate,
  type DefectView,
} from './defect-view';

/** CSV ヘッダ (契約 C3b-3 の列順) */
export const DEFECT_EVIDENCE_CSV_HEADER = [
  '製品名',
  'product_id',
  'バリエーション',
  '発生日',
  '注文日',
  '基準日',
  '経路',
  '原因ラベル',
  '大分類',
  '責任区分',
  'FBA理由コード',
  '注文番号',
  '数量',
] as const;

// Excel 数式インジェクション対策 (OWASP CSV Injection Prevention) の定石:
// 先頭がこれらの文字だと Excel 等が数式として評価してしまうため無害化する
const FORMULA_INJECTION_LEADING_RE = /^[=+\-@\t\r]/;

/**
 * RFC4180 流儀のエスケープ (カンマ・引用符・改行を含む場合のみ引用)。
 * この CSV は工場 (外部) に渡して Excel で開く前提のため、先頭が `=` `+` `-` `@` タブ CR の
 * いずれかの値は単一引用符 `'` を前置してから引用処理する (Excel 数式インジェクション対策)。
 */
export function escapeCsvField(v: string): string {
  const guarded = FORMULA_INJECTION_LEADING_RE.test(v) ? `'${v}` : v;
  if (/[",\r\n]/.test(guarded)) return `"${guarded.replace(/"/g, '""')}"`;
  return guarded;
}

/** エクスポート対象 1 行 (粒度適用済みの集計行 + 名寄せ済み表示名) */
export interface DefectEvidenceCsvRow {
  row: DefectAggRow;
  productName: string;
  /** 親粒度は '' (バリエーション情報なし) */
  variationLabel: string;
}

/**
 * 不良エビデンス CSV (ヘッダ + 明細) を組み立てる。
 * view=factory は責任区分 = factory の案件のみ出力する (画面の表示切替と同一規則)。
 */
export function buildDefectEvidenceCsv(args: {
  rows: readonly DefectEvidenceCsvRow[];
  view: DefectView;
  basis: DefectBasis;
}): string {
  const lines: string[] = [DEFECT_EVIDENCE_CSV_HEADER.join(',')];
  for (const { row, productName, variationLabel } of args.rows) {
    for (const c of filterCasesByView(row.cases, args.view)) {
      const base = [
        productName,
        row.group_id,
        variationLabel,
        c.occurred_date,
        c.order_date ?? '',
        caseBasisDate(c, args.basis),
        caseRouteLabel(c),
      ];
      const tail = [c.order_numbers.join('|'), String(c.count)];
      if (c.causes.length === 0) {
        // 原因未入力の案件 (CSR の対応種別のみ等) も 1 行出す (黙殺防止)
        lines.push([...base, '', '', '', '', ...tail].map(escapeCsvField).join(','));
        continue;
      }
      for (const cause of c.causes) {
        lines.push(
          [
            ...base,
            cause.label,
            MAJOR_CATEGORY_LABELS[cause.major],
            RESPONSIBILITY_LABELS[cause.responsibility],
            cause.fbaReason ?? '',
            ...tail,
          ]
            .map(escapeCsvField)
            .join(','),
        );
      }
    }
  }
  return lines.join('\r\n') + '\r\n';
}
