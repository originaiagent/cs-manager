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

// ---------------------------------------------------------------------------
// 責任区分 (responsibility) — 工場エビデンス化 C3a-1
//   不良原因を「誰の責任か」で切り分ける (工場への改善要求の反論封じ)。
//   判定は原因 (cause) 単位の純関数。案件の代表値は resolveCaseResponsibility。
// ---------------------------------------------------------------------------

export type Responsibility = 'factory' | 'logistics' | 'listing' | 'unverified';

/** 責任区分の日本語表示ラベル */
export const RESPONSIBILITY_LABELS: Record<Responsibility, string> = {
  factory: '工場起因',
  logistics: '配送・倉庫起因',
  listing: '自社(説明・登録)起因',
  unverified: '要精査',
};

export const RESPONSIBILITIES = ['factory', 'logistics', 'listing', 'unverified'] as const;

/**
 * FBA 返品理由コード → 責任区分。
 * FBA コードは顧客の申告 + Amazon 側の判定で major より情報量が多いため最優先。
 * (キーは return-reasons.ts DEFECT_RETURN_REASONS と同じ大文字コード)
 * export は集計定義パネル (C3b-4) がコードと同一の対応表を描画するため (乖離防止)。
 */
export const FBA_REASON_RESPONSIBILITY: Record<string, Responsibility> = {
  DAMAGED_BY_CARRIER: 'logistics',
  DAMAGED_BY_FC: 'logistics',
  DEFECTIVE: 'factory',
  ITEM_DEFECTIVE: 'factory',
  QUALITY_UNACCEPTABLE: 'factory',
  MISSING_PARTS: 'factory',
  NOT_AS_DESCRIBED: 'listing',
};

/**
 * 大分類 → 責任区分 (fbaReason が無い AI/CSR 由来の原因用)。
 * damaged→factory は v1 の割り切り (配送破損は FBA 理由コードでしか判別できない。
 * 定義書に明記して工場交渉で説明する)。
 * export は集計定義パネル (C3b-4) がコードと同一の対応表を描画するため (乖離防止)。
 */
export const MAJOR_RESPONSIBILITY: Record<MajorCategory, Responsibility> = {
  function_defect: 'factory',
  missing_part: 'factory',
  damaged: 'factory',
  color_mismatch: 'factory',
  size_mismatch: 'listing',
  description_mismatch: 'listing',
  other: 'unverified',
};

/**
 * 原因 (cause) 単位の責任区分判定 (純関数)。
 *   1. fbaReason があれば優先 (Amazon 判定込みで情報量が多い)。未知コードは 2 へ。
 *   2. major_category のマッピングで判定。
 */
export function resolveResponsibility(args: {
  majorCategory: MajorCategory;
  fbaReason?: string | null;
}): Responsibility {
  const code = args.fbaReason?.trim().toUpperCase();
  if (code) {
    const byReason = FBA_REASON_RESPONSIBILITY[code];
    if (byReason) return byReason;
  }
  return MAJOR_RESPONSIBILITY[args.majorCategory] ?? 'unverified';
}

/**
 * 案件の責任区分 (代表値)。
 * 1 つでも factory があれば factory。無ければ logistics > listing > unverified の優先順。
 * 原因が 1 つも無い案件は unverified (要精査) 扱い。
 */
export function resolveCaseResponsibility(
  responsibilities: readonly Responsibility[],
): Responsibility {
  for (const r of RESPONSIBILITIES) {
    if (responsibilities.includes(r)) return r;
  }
  return 'unverified';
}
