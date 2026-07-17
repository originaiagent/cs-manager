/**
 * ec-manager 外部 API クライアント (不良発生率ライブ化)
 *
 * - GET /api/external/sales-units      : 期間販売数 (不良率の分母)
 * - GET /api/external/customer-returns : FBA 顧客返品 (理由コード付き、クレーム集計用)
 *
 * 設計 (defect-rate-design.md PART C1-3):
 *   - Base URL は env `EC_MANAGER_API_URL` (必須)。未設定なら ok:false を返す (throw しない。
 *     UI 側で「販売数取得不可」の案内表示に使う)。
 *   - API key は Core `/api/credentials/ec_manager_sales_api` の `api_key` フィールド
 *     (getCredential 内の 5 分 TTL キャッシュを利用)。Core 取得失敗時のみ env
 *     `EC_MANAGER_API_KEY` フォールバック (無停止優先、ec-manager 側 apiKeyAuth と同じ流儀)。
 *   - 鍵をログ・エラーメッセージに出さない。非 2xx は status のみエラー化 (body 反射しない
 *     — core-client.ts と同じ流儀)。
 */

import { getCredential } from '@/lib/credentials';

const EC_MANAGER_TIMEOUT_MS = process.env.EC_MANAGER_TIMEOUT_MS
  ? parseInt(process.env.EC_MANAGER_TIMEOUT_MS, 10)
  : 30_000;

/** sales-units の 1 行 (ec-manager 側は marketplace×item×sku で SQL group by 済) */
export interface SalesUnitRow {
  marketplace: string;
  itemManagementNumber: string | null;
  skuManagementNumber: string | null;
  units: number;
  orderLines: number;
}

/** customer-returns の 1 行 (amazon_customer_returns の生行) */
export interface CustomerReturnRow {
  returnDate: string | null;
  orderId: string | null;
  sku: string | null;
  asin: string | null;
  quantity: number | null;
  reason: string | null;
  detailedDisposition: string | null;
  status: string | null;
  productName: string | null;
}

export interface FetchSalesUnitsResult {
  ok: boolean;
  rows?: SalesUnitRow[];
  error?: string;
}

export interface FetchCustomerReturnsResult {
  ok: boolean;
  rows?: CustomerReturnRow[];
  /** ec-manager 側の上限 (5000 行) で切られた場合 true */
  truncated?: boolean;
  error?: string;
}

/** 期間指定 (YYYY-MM-DD, end は inclusive) */
export interface PeriodArgs {
  start: string;
  end: string;
}

function envBaseUrl(): string | null {
  const url = process.env.EC_MANAGER_API_URL?.replace(/\s+$/, '');
  return url ? url.replace(/\/$/, '') : null;
}

/**
 * API key を解決する。Core 優先 → env EC_MANAGER_API_KEY フォールバック。
 * どちらも無ければ null (呼出側で ok:false)。値はログに出さない。
 */
async function resolveApiKey(): Promise<string | null> {
  try {
    const cred = await getCredential<{ api_key?: unknown }>('ec_manager_sales_api');
    const v = cred.credentials?.api_key;
    if (typeof v === 'string') {
      const trimmed = v.replace(/\s+$/, '');
      if (trimmed.length > 0) return trimmed;
    }
  } catch {
    // Core 障害時は env フォールバックに落とす (無停止優先。鍵値・失敗詳細は出さない)
  }
  const envKey = process.env.EC_MANAGER_API_KEY?.replace(/\s+$/, '');
  return envKey || null;
}

/**
 * ec-manager 外部 API への共通 GET。設定不備・失敗は throw せず error 文字列で返す。
 */
async function requestEcManager(
  path: string,
  args: PeriodArgs,
): Promise<{ ok: true; json: unknown } | { ok: false; error: string }> {
  const baseUrl = envBaseUrl();
  if (!baseUrl) {
    return { ok: false, error: 'EC_MANAGER_API_URL is not set' };
  }
  const apiKey = await resolveApiKey();
  if (!apiKey) {
    return { ok: false, error: 'ec-manager API key unavailable (Core/env)' };
  }

  const url = new URL(`${baseUrl}${path}`);
  url.searchParams.set('startDate', args.start);
  url.searchParams.set('endDate', args.end);

  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'x-api-key': apiKey,
      },
      signal: AbortSignal.timeout(EC_MANAGER_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!res.ok) {
      // 非 2xx の body は反射しない (status のみ)。
      try { await res.arrayBuffer(); } catch { /* ignore */ }
      return { ok: false, error: `ec-manager API error: ${res.status} ${res.statusText}` };
    }
    return { ok: true, json: await res.json() };
  } catch (error: any) {
    const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return {
      ok: false,
      error: isTimeout
        ? `Timeout after ${EC_MANAGER_TIMEOUT_MS}ms`
        : `Network error: ${error?.message ?? String(error)}`,
    };
  }
}

/**
 * 期間販売数 (全モール、marketplace×item×sku 集計済) を取得する。
 * 不良率の分母 (期間販売数) 用。
 */
export async function fetchSalesUnits(args: PeriodArgs): Promise<FetchSalesUnitsResult> {
  const res = await requestEcManager('/api/external/sales-units', args);
  if (!res.ok) return { ok: false, error: res.error };

  const body = res.json as { rows?: unknown };
  if (!body || !Array.isArray(body.rows)) {
    return { ok: false, error: 'Unexpected response shape (rows missing)' };
  }
  return { ok: true, rows: body.rows as SalesUnitRow[] };
}

/**
 * FBA 顧客返品 (return_date 基準、生行) を取得する。
 * 理由コード (reason) 付き。クレーム集計 (return-reasons.ts でマップ) に使う。
 */
export async function fetchCustomerReturns(
  args: PeriodArgs,
): Promise<FetchCustomerReturnsResult> {
  const res = await requestEcManager('/api/external/customer-returns', args);
  if (!res.ok) return { ok: false, error: res.error };

  const body = res.json as { rows?: unknown; truncated?: unknown };
  if (!body || !Array.isArray(body.rows)) {
    return { ok: false, error: 'Unexpected response shape (rows missing)' };
  }
  return {
    ok: true,
    rows: body.rows as CustomerReturnRow[],
    truncated: body.truncated === true,
  };
}
