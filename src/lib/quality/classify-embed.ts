/**
 * 分類2cron (defect-classify.ts / return-comment-classify.ts) の origin-ai embed 経路 共通定義。
 *
 * 設計: cs-manager PR「分類2cronのembed oneshot移行」(レガシー掃除第2弾・順序4)。
 * 対象2 oneshot の slug / target_type とロールバックスイッチ、fail-closed 形状検証の
 * 共有ヘルパをここに集約する (defect-classify.ts / return-comment-classify.ts / diag/ai route
 * の3箇所で slug 文字列や検証ロジックが分岐・重複しないようにするため)。
 *
 * fail-closed 形状検証の不変条件 (codex 設計レビュー APPROVE の追加条件):
 *   - trim / toLowerCase / normalizeMajorCategory 等の正規化・救済は行わない (enum 完全一致のみ)。
 *   - 不正要素 (label 空文字・major_category 非enum) は黙って除外せず、1件でもあれば
 *     配列全体を invalid (null) として扱う (呼出側は分類失敗として fail-closed する)。
 *   - 重複 label (同一値の再掲) も不正扱いで配列全体を invalid にする。
 *   - これは「本文 JSON regex フォールバック」(旧 invokeChat 経路の extractClassification /
 *     extractSymptoms) とは別物。新 embed 経路の origin-ai 応答専用の検証であり、旧経路の
 *     救済的パース (normalize/skip) は流用しない。
 */

import { MAJOR_CATEGORIES, type MajorCategory } from './defect-taxonomy';

/** 分類2cron の origin-ai embed 作業 slug (bare slug。'oneshot:' prefix は付けない)。 */
export const DEFECT_CLASSIFY_EMBED_SLUG = 'cs:classify-defect';
export const RETURN_COMMENT_CLASSIFY_EMBED_SLUG = 'cs:classify-return-comment';

/** embed target_type (embed クライアントの allowed_target_types に含まれる値)。 */
export const DEFECT_CLASSIFY_EMBED_TARGET_TYPE = 'customer_record';
export const RETURN_COMMENT_CLASSIFY_EMBED_TARGET_TYPE = 'fba_return';

/** 分類呼出の poll deadline/interval (cron 背景処理のため cs-reply:draft の 150s より短く設定)。 */
export const CLASSIFY_EMBED_POLL_DEADLINE_MS = 90_000;
export const CLASSIFY_EMBED_POLL_INTERVAL_MS = 2_000;

/**
 * ロールバックスイッチ (G2)。既定 false (legacy invokeChat 経路)。env `CLASSIFY_VIA_EMBED=true` を
 * 明示指定した時のみ origin-ai embed 経路へ切替わる (このPRでは旧経路コードを削除しない。
 * 切替判断は司令塔がトム確認とセットで行うため、この叩き台段階では挙動を変えない=既定OFF)。
 */
export function classifyViaEmbed(): boolean {
  return process.env.CLASSIFY_VIA_EMBED === 'true';
}

/** causes/symptoms 共通の要素型 (label + major_category)。 */
export interface EmbedLabelledCause {
  label: string;
  major_category: MajorCategory;
}

/**
 * causes/symptoms 配列の fail-closed 形状検証 (embed 経路専用)。
 *
 * - 配列必須 (欠落・非配列は invalid)。0〜3 件のみ許容 (4件以上は invalid)。
 * - 各要素: object であること / label は非空文字列。空白のみの文字列 (例 "   ") は
 *   trim 後に空になるため invalid 判定する (判定にのみ trim を使う。値の整形・保存への
 *   trim 適用=救済はしない。保存される label は常に原文のまま = fail-closed 維持)。
 * - major_category は許可 enum に完全一致 (大文字小文字・空白の正規化なし)。
 * - label の重複 (同一値の再掲) は invalid。
 * - 1つでも不正な要素があれば黙って除外せず、配列全体を invalid (null) にする。
 */
export function validateEmbedCauseArray(value: unknown): EmbedLabelledCause[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > 3) return null;

  const seen = new Set<string>();
  const out: EmbedLabelledCause[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const obj = item as Record<string, unknown>;

    const label = obj.label;
    // 判定にのみ trim を使う (空白のみの label を invalid にする)。保存する label 自体は
    // 原文のまま (trim 後の値に差し替える救済はしない = fail-closed 維持)。
    if (typeof label !== 'string' || label.trim().length === 0) return null;
    if (seen.has(label)) return null; // 重複要素は不正扱い (黙殺しない)

    const majorCategory = obj.major_category;
    if (
      typeof majorCategory !== 'string' ||
      !(MAJOR_CATEGORIES as readonly string[]).includes(majorCategory)
    ) {
      return null;
    }

    seen.add(label);
    out.push({ label, major_category: majorCategory as MajorCategory });
  }
  return out;
}
