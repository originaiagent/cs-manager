/**
 * 不良原因の大分類 (major_category) 定義。
 *
 * DB (ticket_defect_causes.major_category の CHECK 制約) と同一値。ここが唯一の定義元。
 * 旧 tickets.defect_type の enum (src/lib/format.ts DEFECT_TYPE_LABELS) とは別体系。
 * format.ts 側は legacy ticket の後方互換表示用に残す (触らない)。
 */

export const MAJOR_CATEGORIES = [
  'function_defect',
  'damaged',
  'missing_part',
  'size_mismatch',
  'color_mismatch',
  'description_mismatch',
  'other',
] as const;

export type MajorCategory = (typeof MAJOR_CATEGORIES)[number];

/** 大分類の日本語表示ラベル */
export const MAJOR_CATEGORY_LABELS: Record<MajorCategory, string> = {
  function_defect: '機能不良',
  damaged: '破損・傷',
  missing_part: '部品欠品',
  size_mismatch: 'サイズ相違',
  color_mismatch: '色相違',
  description_mismatch: '説明相違',
  other: 'その他',
};

export function isMajorCategory(v: unknown): v is MajorCategory {
  return typeof v === 'string' && (MAJOR_CATEGORIES as readonly string[]).includes(v);
}

/** 未知・不正な値は 'other' に正規化する (AI 出力のバリデーション用) */
export function normalizeMajorCategory(v: unknown): MajorCategory {
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (isMajorCategory(t)) return t;
  }
  return 'other';
}
