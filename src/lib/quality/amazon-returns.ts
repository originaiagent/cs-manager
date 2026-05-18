/**
 * Amazon 返品数取得 (stub)
 *
 * TODO: Core sales-stats API が拡張され次第、`GET ${CORE_API_URL}/api/v1/master/products/{id}/sales-stats?month=YYYY-MM`
 *       経由で Amazon 返品数を取得する実装に差し替える。
 *
 * 現状: Core 側に sales-stats エンドポイントが未実装 (2026-05-18 確認、404/SPA fallback)
 * → このスタブは return 0 を返す。/quality/defect-rate の不良数集計は当面
 *    (tickets.case_category='defect') + (customer_service_records 不良判定) のみで構成。
 *
 * Single Source of Truth (B 案原則):
 *   - 商品マスタ・販売実績は origin-core が正
 *   - cs-manager のローカル DB に Amazon 返品数のコピーを持たない
 */

export interface AmazonReturnsResult {
  ok: boolean;
  /** 返品数。stub では常に 0 */
  count: number;
  /** API 未実装で stub を返したフラグ (UI で「-」表記に使う) */
  stub: boolean;
  error?: string;
}

/**
 * @param productId Core product.id (integer)
 * @param monthKey `YYYY-MM` 形式 (Asia/Tokyo)
 */
export async function fetchAmazonReturnsByProduct(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  productId: number | string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  monthKey: string,
): Promise<AmazonReturnsResult> {
  // Core sales-stats API 拡張までは stub で 0 を返す。
  // 実装時はここを fetch + X-Internal-API-Key + Asia/Tokyo 整合で書く。
  return { ok: true, count: 0, stub: true };
}
