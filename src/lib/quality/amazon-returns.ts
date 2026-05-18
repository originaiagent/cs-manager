/**
 * Amazon 返品数取得 (stub)
 *
 * TODO: Core sales-stats API が拡張され次第、
 *   `GET ${CORE_API_URL}/api/v1/master/products/{id}/sales-stats?period=...&month=YYYY-MM`
 * 経由で Amazon 返品数を取得する実装に差し替える。
 *
 * 現状: Core 側に sales-stats エンドポイントが未実装 (2026-05-18 確認、404/SPA fallback)
 * → このスタブは return 0 + stub: true を返す。/quality/defect-rate 集計側では
 *    `stub === true` の場合は不良数に加算しない (UI 表示も「-」)。
 *
 * Single Source of Truth (B 案原則):
 *   - 商品マスタ・販売実績は origin-core が正
 *   - cs-manager のローカル DB に Amazon 返品数のコピーを持たない
 *
 * インターフェース設計 (codex R3 PR-C feedback 反映):
 *   - period / monthKey を明示。将来実装時に呼び出し側の期間整合性を保てる
 *   - variation 粒度の重複加算は呼び出し側で `granularity === 'variation' &&
 *     variation_label === VARIATION_UNKNOWN` の行にのみ加算することで吸収する
 *     (Amazon 返品数は product 単位までしか取れない設計を前提)
 */

export type Period = '30d' | '90d' | 'all' | 'monthly';

export interface AmazonReturnsArgs {
  productId: number | string;
  period: Period;
  /** period='monthly' の時のみ参照。`YYYY-MM` (Asia/Tokyo) */
  monthKey?: string | null;
}

export interface AmazonReturnsResult {
  ok: boolean;
  /** 返品数。stub では常に 0 */
  count: number;
  /** API 未実装で stub を返したフラグ。true なら呼び出し側で不良数に加算しない (UI で「-」表記) */
  stub: boolean;
  error?: string;
}

export async function fetchAmazonReturnsByProduct(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  args: AmazonReturnsArgs,
): Promise<AmazonReturnsResult> {
  // Core sales-stats API 拡張までは stub。
  // 実装時はここを fetch + X-Internal-API-Key + period/monthKey を URL params に乗せて書く。
  return { ok: true, count: 0, stub: true };
}
