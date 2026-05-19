/**
 * customer_service_records 一覧検索 / ページネーション用ヘルパー
 *
 * UI (`app/customer-records/page.tsx`) と API (`app/api/customer-records/route.ts`) の
 * 両方から共通利用される。重複ロジック (ISO 日付バリデーション・検索フィルタ適用) を
 * 1 箇所に集約することで仕様ズレを防止する。
 *
 * 型方針:
 *   - SupabaseClient の query builder は ilike/gte/lte 等のチェイン後も自身の型を保つため
 *     <T> ジェネリックで受けて返す。`any` は使わず、呼び出し側の型を壊さない。
 */

export interface RecordSearchParams {
  product?: string;
  recipient?: string;
  order?: string;
  date_from?: string;
  date_to?: string;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `YYYY-MM-DD` の形式チェック + 実在日付チェック。
 * 2026-99-99 のような形式上は通るが存在しない日付を弾く。
 */
export function isIsoDate(v: string): boolean {
  if (!ISO_DATE_RE.test(v)) return false;
  const [y, m, d] = v.split('-').map((s) => parseInt(s, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

/**
 * Supabase query builder に検索フィルタを適用。
 * - product / recipient / order: ILIKE 部分一致
 * - date_from / date_to: record_date >= / <=
 * 無効値 (空白のみ・不正日付) は無視。
 */
export function applySearchFilters<T extends {
  ilike: (column: string, pattern: string) => T;
  gte: (column: string, value: string) => T;
  lte: (column: string, value: string) => T;
}>(q: T, params: RecordSearchParams): T {
  if (params.product && params.product.trim()) {
    q = q.ilike('product_name_text', `%${params.product.trim()}%`);
  }
  if (params.recipient && params.recipient.trim()) {
    q = q.ilike('recipient_name', `%${params.recipient.trim()}%`);
  }
  if (params.order && params.order.trim()) {
    q = q.ilike('order_number', `%${params.order.trim()}%`);
  }
  if (params.date_from && isIsoDate(params.date_from)) {
    q = q.gte('record_date', params.date_from);
  }
  if (params.date_to && isIsoDate(params.date_to)) {
    q = q.lte('record_date', params.date_to);
  }
  return q;
}

type SearchParamSource = URLSearchParams | Record<string, string | undefined>;

function getParam(sp: SearchParamSource, key: string): string | undefined {
  if (sp instanceof URLSearchParams) {
    return sp.get(key) ?? undefined;
  }
  return sp[key];
}

/**
 * URLSearchParams (route.ts) と Record<string, string | undefined> (page.tsx searchParams)
 * の両方を受け、検索条件を抽出して返す。
 */
export function parseSearchParams(sp: SearchParamSource): RecordSearchParams {
  return {
    product: getParam(sp, 'product'),
    recipient: getParam(sp, 'recipient'),
    order: getParam(sp, 'order'),
    date_from: getParam(sp, 'date_from'),
    date_to: getParam(sp, 'date_to'),
  };
}

export interface Pagination {
  page: number;
  pageSize: number;
}

/**
 * page / page_size を抽出。
 * - page: 1-based, 最小 1
 * - page_size: default 50, 最小 1, 最大 200
 */
export function parsePagination(sp: SearchParamSource): Pagination {
  const pageRaw = getParam(sp, 'page');
  const pageSizeRaw = getParam(sp, 'page_size');
  const page = Math.max(parseInt(pageRaw ?? '1', 10) || 1, 1);
  const pageSize = Math.min(
    Math.max(parseInt(pageSizeRaw ?? '50', 10) || 50, 1),
    200,
  );
  return { page, pageSize };
}
