/**
 * 不良率ページの表示切替 (view) ヘルパ — 工場エビデンス化 C3b-2 (純関数・vitest 対象)
 *
 *   - view='all' (既定): 全案件をそのまま表示 (現行どおり)。
 *   - view='factory': 責任区分 = factory (工場起因) の案件のみで
 *     不良数・不良率・原因内訳を再計算する (工場への改善要求エビデンス用)。
 *     除外した案件数 (配送・倉庫 / 自社 / 要精査) は UI 注記に使う。
 *
 * client component (defect-rate-table) と server (page / CSV export) の両方から
 * import するため、ここには I/O・server 専用 import を置かない。
 */

import {
  RESPONSIBILITIES,
  type Responsibility,
} from './defect-taxonomy';
import type { DefectAggRow, DefectCaseDetail } from './defect-aggregate';

export const DEFECT_VIEWS = ['all', 'factory'] as const;
export type DefectView = (typeof DEFECT_VIEWS)[number];

export const DEFECT_VIEW_LABELS: Record<DefectView, string> = {
  all: '全体',
  factory: '工場起因のみ',
};

/** view で案件明細を絞る (factory は案件代表の責任区分で判定 = 案件単位フィルタ) */
export function filterCasesByView(
  cases: readonly DefectCaseDetail[],
  view: DefectView,
): DefectCaseDetail[] {
  if (view === 'factory') return cases.filter((c) => c.responsibility === 'factory');
  return [...cases];
}

/** view 適用後の行表示値 (不良数・率・原因内訳を再計算した結果) */
export interface ViewAdjustedRow {
  /** view 適用後の不良案件数 (count 換算) */
  total_cases: number;
  /** total_cases / sales_units (分母なし・0 は null = UI '-') */
  rate: number | null;
  /** view 適用後の案件明細 (元の並び = 発生日降順を維持) */
  cases: DefectCaseDetail[];
  /** view 適用後の原因ラベル → 案件数 (1 案件複数原因のため合計 ≠ total_cases) */
  cause_breakdown: Record<string, number>;
}

/**
 * 行に view を適用して不良数・率・原因内訳を再計算する。
 * view='all' でも同じ計算経路を通す (aggregate 側の cause_breakdown と同一定義:
 * 案件 count を案件が持つ各原因ラベルへ加算)。
 */
export function applyViewToRow(row: DefectAggRow, view: DefectView): ViewAdjustedRow {
  const cases = filterCasesByView(row.cases, view);
  let total = 0;
  const breakdown: Record<string, number> = {};
  for (const c of cases) {
    total += c.count;
    for (const cause of c.causes) {
      breakdown[cause.label] = (breakdown[cause.label] ?? 0) + c.count;
    }
  }
  const rate =
    row.sales_units != null && row.sales_units > 0 ? total / row.sales_units : null;
  return { total_cases: total, rate, cases, cause_breakdown: breakdown };
}

/**
 * factory view で除外した案件数の内訳 (責任区分別、factory 以外のみ)。
 * 表示中の行集合 (粒度適用済み) を渡す — 親行と子行は同一案件を共有するため混在させない。
 */
export function excludedByResponsibility(
  rows: readonly DefectAggRow[],
): Record<Exclude<Responsibility, 'factory'>, number> {
  const acc = { logistics: 0, listing: 0, unverified: 0 };
  for (const row of rows) {
    for (const r of RESPONSIBILITIES) {
      if (r === 'factory') continue;
      acc[r] += row.responsibility_breakdown[r] ?? 0;
    }
  }
  return acc;
}

/** 原因内訳の上位 n 件 (件数降順 → ラベル ja 昇順)。サマリの「主な原因上位2」用 */
export function topCauses(
  breakdown: Record<string, number>,
  n: number,
): Array<{ label: string; count: number }> {
  return Object.entries(breakdown)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.label.localeCompare(b.label, 'ja')))
    .slice(0, n);
}

// ---------------------------------------------------------------------------
// 経路 (どの受付経路から来た案件か) の表示ラベル
// ---------------------------------------------------------------------------

/**
 * チャネルコード → 日本語表示。channels.code (rakuten/email/line/yahoo/amazon) と
 * CSR order_channel (amazon/rakuten/yahoo/self/other) の両方をカバーする。
 */
const CHANNEL_LABELS: Record<string, string> = {
  rakuten: '楽天',
  amazon: 'Amazon',
  yahoo: 'Yahoo',
  email: 'メール',
  line: 'LINE',
  self: '自社EC',
  other: 'その他',
};

/**
 * 案件の経路ラベル (例: '楽天' / 'FBA返品' / '対応記録' / '楽天+対応記録')。
 * ticket 由来はチャネル名で表示し (不明コードは原文)、csr/fba は固定ラベル。
 */
export function caseRouteLabel(c: DefectCaseDetail): string {
  const parts: string[] = [];
  for (const s of c.sources) {
    if (s === 'ticket') {
      const code = c.channel_code?.trim().toLowerCase();
      parts.push((code && CHANNEL_LABELS[code]) || c.channel_code || 'チケット');
    } else if (s === 'csr') {
      parts.push('対応記録');
    } else {
      parts.push('FBA返品');
    }
  }
  return parts.join('+') || '-';
}

/** 案件の基準日 (basis 適用後): ordered は注文日 (不明時は発生日で代用)、occurred は発生日 */
export function caseBasisDate(c: DefectCaseDetail, basis: 'occurred' | 'ordered'): string {
  if (basis === 'ordered') return c.order_date ?? c.occurred_date;
  return c.occurred_date;
}
