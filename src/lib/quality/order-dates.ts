/**
 * 注文日の解決 (工場エビデンス化 C3a-3)
 *
 * 注文日ベース帰属 (basis='ordered') 用に、案件が持つ注文番号から注文日 (YYYY-MM-DD) を解決する。
 *   - 楽天注文番号: 形式 `店舗ID6桁-注文日YYYYMMDD-連番` (実データ例 '408672-2...')。
 *     番号自体に注文日が埋まっているためローカルでパースする (API 不要)。
 *     defensive: 形式に一致し実在日である場合のみ採用 (それ以外は解決不能 = 発生日フォールバック)。
 *   - Amazon 注文 ID: 3-7-7 形式 (`XXX-XXXXXXX-XXXXXXX`)。ec-manager
 *     `/api/external/order-dates` (fetchOrderDates, 500 件チャンク) で
 *     amazon_financial_events の min(posted_date) ≒ 注文日近似を引く。
 *   - どちらでも解決できない注文番号は結果に含めない (集計側が発生日でフォールバック)。
 */

import { fetchOrderDates } from '@/lib/ec-manager/client';
import { isValidYmd } from './period';

/** 楽天注文番号: 店舗ID6桁-注文日8桁(YYYYMMDD)-連番 (連番の桁数は縛らない defensive) */
const RAKUTEN_ORDER_RE = /^\d{6}-(\d{8})-\d+$/;

/** Amazon 注文 ID: 3-7-7 形式 */
const AMAZON_ORDER_RE = /^\d{3}-\d{7}-\d{7}$/;

/**
 * 楽天注文番号から注文日 (YYYY-MM-DD) を直接パースする (純関数)。
 * 形式不一致・実在しない日付 (2月30日等) は null。
 */
export function parseRakutenOrderDate(orderNumber: string | null | undefined): string | null {
  const t = orderNumber?.trim();
  if (!t) return null;
  const m = RAKUTEN_ORDER_RE.exec(t);
  if (!m) return null;
  const ymd = `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}`;
  return isValidYmd(ymd) ? ymd : null;
}

/** Amazon 注文 ID (3-7-7 形式) か (純関数) */
export function isAmazonOrderId(orderNumber: string | null | undefined): boolean {
  const t = orderNumber?.trim();
  return !!t && AMAZON_ORDER_RE.test(t);
}

/**
 * 注文番号集合を「楽天パース済み / Amazon 照会対象 / 解決不能」に振り分ける (純関数)。
 * 楽天は 3-7-7 と衝突しない (先頭 6 桁 + 8 桁) ため判定順に依存しないが、楽天を先に処理する。
 */
export function partitionOrderNumbers(orderNumbers: Iterable<string>): {
  /** 楽天注文番号からローカル解決した注文日 */
  dates: Map<string, string>;
  /** ec-manager へ照会する Amazon 注文 ID (重複除去済み) */
  amazonIds: string[];
  /** どちらの形式でもない注文番号 (発生日フォールバック対象) */
  unresolved: string[];
} {
  const dates = new Map<string, string>();
  const amazonIds: string[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const raw of orderNumbers) {
    const on = raw?.trim();
    if (!on || seen.has(on)) continue;
    seen.add(on);
    const rakutenDate = parseRakutenOrderDate(on);
    if (rakutenDate) {
      dates.set(on, rakutenDate);
    } else if (isAmazonOrderId(on)) {
      amazonIds.push(on);
    } else {
      unresolved.push(on);
    }
  }
  return { dates, amazonIds, unresolved };
}

export interface ResolveOrderDatesResult {
  /** 注文番号 → 注文日 (YYYY-MM-DD)。解決不能な注文番号はキー無し */
  dates: Map<string, string>;
  /** Amazon 注文日 API (ec-manager) の呼び出しに失敗したか (UI 注記用。楽天パース分は影響なし) */
  amazonLookupFailed: boolean;
}

/**
 * 注文番号 → 注文日を一括解決する。
 * 楽天はローカルパース、Amazon は ec-manager /api/external/order-dates。
 * API 失敗時も throw せず楽天分だけ返す (ページは落とさない。失敗はフラグで可視化)。
 */
export async function resolveOrderDates(
  orderNumbers: Iterable<string>,
): Promise<ResolveOrderDatesResult> {
  const { dates, amazonIds } = partitionOrderNumbers(orderNumbers);
  if (amazonIds.length === 0) return { dates, amazonLookupFailed: false };

  const res = await fetchOrderDates(amazonIds);
  if (!res.ok || !res.dates) return { dates, amazonLookupFailed: true };
  for (const [orderId, ymd] of Object.entries(res.dates)) {
    // API 応答も defensive に実在日のみ採用 (不正値は解決不能扱い)
    if (isValidYmd(ymd)) dates.set(orderId, ymd);
  }
  return { dates, amazonLookupFailed: false };
}
