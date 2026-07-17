/**
 * FBA 返品理由コード → 不良原因 (major_category + 日本語 cause label) マッピング
 *
 * 設計 (defect-rate-design.md PART C1-5):
 *   - 不良系 (商品起因) の代表コードのみマップする。
 *   - 顧客都合 (UNWANTED_ITEM 等) の既知コードは不良集計から完全除外。
 *   - 未知コードは除外しつつ「未分類返品 n 件」として可視化できるよう分離して返す
 *     (実在コード一覧は ec-manager の実データ = Amazon FBA Customer Returns report に依存)。
 */

import type { MajorCategory } from './defect-taxonomy';

export interface ReturnReasonMapping {
  majorCategory: MajorCategory;
  /** 日本語の原因ラベル (集計時に ticket/CSR 由来 cause と同列に扱う) */
  causeLabel: string;
  /**
   * FBA 返品理由コード原文 (正規化済み大文字)。責任区分判定 (resolveResponsibility) と
   * エビデンス明細への理由コード表示に使う (工場エビデンス化 C3a-1 で additive 追加)。
   */
  fbaReason: string;
}

/**
 * 不良系 (商品起因) 返品理由 → 大分類 + 日本語ラベル。
 * キーは Amazon FBA 返品レポートの reason コード (大文字)。
 */
const DEFECT_RETURN_REASONS: Record<string, Omit<ReturnReasonMapping, 'fbaReason'>> = {
  DEFECTIVE: { majorCategory: 'function_defect', causeLabel: '不良・故障' },
  ITEM_DEFECTIVE: { majorCategory: 'function_defect', causeLabel: '不良・故障' },
  QUALITY_UNACCEPTABLE: { majorCategory: 'other', causeLabel: '品質不良' },
  MISSING_PARTS: { majorCategory: 'missing_part', causeLabel: '部品欠品' },
  NOT_AS_DESCRIBED: { majorCategory: 'description_mismatch', causeLabel: '説明と相違' },
  DAMAGED_BY_FC: { majorCategory: 'damaged', causeLabel: '倉庫内破損' },
  DAMAGED_BY_CARRIER: { majorCategory: 'damaged', causeLabel: '配送中破損' },
};

/**
 * 既知の顧客都合 (商品起因ではない) 返品理由。不良集計から除外し、未分類にも数えない。
 * APPAREL_STYLE は契約で明示的に「含めない」(好みの問題 = 顧客都合)。
 * export は集計定義パネル (C3b-4) がコードと同一の除外コード群を描画するため (乖離防止)。
 */
export const NON_DEFECT_RETURN_REASONS = new Set<string>([
  'NO_REASON_GIVEN',
  'UNWANTED_ITEM',
  'UNAUTHORIZED_PURCHASE',
  'ORDERED_WRONG_ITEM',
  'FOUND_BETTER_PRICE',
  'MISSED_ESTIMATED_DELIVERY',
  'NOT_COMPATIBLE',
  'NEVER_ARRIVED',
  'DAMAGED_BY_CUSTOMER',
  'CUSTOMER_DAMAGED',
  'APPAREL_STYLE',
  'APPAREL_TOO_SMALL',
  'APPAREL_TOO_LARGE',
  'JEWELRY_TOO_SMALL',
  'JEWELRY_TOO_LARGE',
  'UNDELIVERABLE_REFUSED',
  'UNDELIVERABLE_UNKNOWN',
  'UNDELIVERABLE_INSUFFICIENT_ADDRESS',
  'UNDELIVERABLE_FAILED_DELIVERY_ATTEMPTS',
  'UNDELIVERABLE_UNCLAIMED',
  'EXTRA_ITEM',
  'SWITCHEROO',
]);

/**
 * 返品理由コードを不良原因にマップする。
 * 不良系でない場合 (顧客都合・未知・空) は undefined = 不良集計から除外。
 */
export function mapReturnReason(
  reason: string | null | undefined,
): ReturnReasonMapping | undefined {
  if (typeof reason !== 'string') return undefined;
  const code = reason.trim().toUpperCase();
  if (!code) return undefined;
  const entry = DEFECT_RETURN_REASONS[code];
  // fbaReason (理由コード原文) を保持して返す (責任区分判定・明細表示用)
  return entry ? { ...entry, fbaReason: code } : undefined;
}

/** 既知の顧客都合コードか (未分類 (unknown) との区別に使う)。 */
export function isKnownNonDefectReason(reason: string | null | undefined): boolean {
  if (typeof reason !== 'string') return false;
  return NON_DEFECT_RETURN_REASONS.has(reason.trim().toUpperCase());
}

export interface SplitReturnsResult<T> {
  /** 不良系にマップできた行 (majorCategory / causeLabel 付き) */
  defects: Array<{ row: T; mapping: ReturnReasonMapping }>;
  /** 既知の顧客都合 → 不良集計から除外 (未分類にも数えない) */
  excluded: T[];
  /** 未知コード・理由なし → 集計側で「未分類返品 n 件」として注記表示 */
  unclassified: T[];
}

/**
 * 返品行を「不良系 / 顧客都合 (除外) / 未分類」に振り分ける。
 * 集計側 (defect-aggregate) は defects のみ不良案件に加算し、
 * unclassified.length を「未分類返品 n 件」として可視化する。
 */
export function splitReturnsByReason<T extends { reason: string | null }>(
  rows: T[],
): SplitReturnsResult<T> {
  const result: SplitReturnsResult<T> = { defects: [], excluded: [], unclassified: [] };
  for (const row of rows) {
    const mapping = mapReturnReason(row.reason);
    if (mapping) {
      result.defects.push({ row, mapping });
    } else if (isKnownNonDefectReason(row.reason)) {
      result.excluded.push(row);
    } else {
      result.unclassified.push(row);
    }
  }
  return result;
}
