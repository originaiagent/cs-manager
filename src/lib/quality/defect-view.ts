/**
 * 不良率ページの表示ヘルパ (純関数・vitest 対象)
 *
 * client component (defect-rate-table) と server (page / CSV export) の両方から
 * import するため、ここには I/O・server 専用 import を置かない。
 */

import type { DefectCaseDetail } from './defect-aggregate';

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
