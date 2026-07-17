/**
 * Core API Client
 *
 * origin-core 接続用の薄いラッパー。
 * - 認証: X-Internal-API-Key
 * - URL/Key は env 必須（Fail Fast、ハードコード fallback なし）
 */

import { getEntryKeys, fetchWithEntryKeys } from '@/lib/core-entry-keys';

const CORE_API_URL = process.env.CORE_API_URL?.replace(/\s+$/, '');
const CORE_API_TIMEOUT_MS = process.env.CORE_API_TIMEOUT_MS
  ? parseInt(process.env.CORE_API_TIMEOUT_MS, 10)
  : 10_000;

export interface CoreProduct {
  id: number | string;
  product_name?: string;
  variation?: string | null;
  jan_code?: string | null;
  group_name?: string | null;
  [key: string]: any;
}

export interface FetchProductResult {
  ok: boolean;
  product?: CoreProduct;
  error?: string;
}

export interface FetchProductsResult {
  ok: boolean;
  count: number;
  sample?: CoreProduct;
  error?: string;
}

export async function fetchProducts(limit: number = 1): Promise<FetchProductsResult> {
  if (!CORE_API_URL) {
    return { ok: false, count: 0, error: 'CORE_API_URL is not set' };
  }
  const entryKeys = getEntryKeys();
  if (entryKeys.length === 0) {
    return { ok: false, count: 0, error: 'CORE_CREDENTIAL_KEY is not set' };
  }

  const url = `${CORE_API_URL.replace(/\/$/, '')}/api/v1/master/products?limit=${limit}`;

  try {
    const response = await fetchWithEntryKeys(
      url,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(CORE_API_TIMEOUT_MS),
      },
      { entryKeys },
    );

    if (!response.ok) {
      // 非 2xx の body は反射しない (status のみ)。
      try { await response.arrayBuffer(); } catch { /* ignore */ }
      return {
        ok: false,
        count: 0,
        error: `Core API error: ${response.status} ${response.statusText}`,
      };
    }

    const data = await response.json();
    const products = Array.isArray(data) ? data : (data.products ?? data.data ?? []);
    return {
      ok: true,
      count: products.length,
      sample: products[0],
    };
  } catch (error: any) {
    const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return {
      ok: false,
      count: 0,
      error: isTimeout
        ? `Timeout after ${CORE_API_TIMEOUT_MS}ms`
        : `Network error: ${error?.message ?? String(error)}`,
    };
  }
}

/**
 * Fetch a single product from origin-core (Master v1).
 *
 * - エンドポイント: GET /api/v1/master/products/{id}
 * - 落とさない設計: 失敗時は ok=false + error を返し UI 側でフォールバック表示
 */
export async function fetchProductById(productId: string): Promise<FetchProductResult> {
  if (!CORE_API_URL) {
    return { ok: false, error: 'CORE_API_URL is not set' };
  }
  const entryKeys = getEntryKeys();
  if (entryKeys.length === 0) {
    return { ok: false, error: 'CORE_CREDENTIAL_KEY is not set' };
  }

  const safeId = encodeURIComponent(productId);
  const url = `${CORE_API_URL.replace(/\/$/, '')}/api/v1/master/products/${safeId}`;

  try {
    const response = await fetchWithEntryKeys(
      url,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(CORE_API_TIMEOUT_MS),
      },
      { entryKeys },
    );

    if (!response.ok) {
      // 非 2xx の body は反射しない (status のみ)。
      try { await response.arrayBuffer(); } catch { /* ignore */ }
      return {
        ok: false,
        error: `Core API error: ${response.status} ${response.statusText}`,
      };
    }

    const data = await response.json();
    const product = data?.data ?? data;
    if (!product || typeof product !== 'object') {
      return { ok: false, error: 'Unexpected response shape' };
    }
    return { ok: true, product: product as CoreProduct };
  } catch (error: any) {
    const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return {
      ok: false,
      error: isTimeout
        ? `Timeout after ${CORE_API_TIMEOUT_MS}ms`
        : `Network error: ${error?.message ?? String(error)}`,
    };
  }
}

// ============================================================================
// mall-identifiers 逆引き (不良発生率ライブ化 C1-4)
// ============================================================================

/**
 * lookup-bulk の 1 リクエスト最大 values 数。
 * origin-core server/routes/masterV1.ts の MAX_BULK=500 と同値 (超過は Core が 400)。
 */
export const MALL_LOOKUP_MAX_BULK = 500;

/** 配列を size 件ごとのチャンクに分割する (lookup-bulk の MAX_BULK 対策)。テスト対象。 */
export function chunkValues<T>(values: T[], size: number): T[][] {
  if (size <= 0) throw new Error(`chunkValues: size must be positive (got ${size})`);
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}

/**
 * mall_identifiers の検索スロット。Core masterV1 lookup-bulk は identifier_1..identifier_10 を
 * 受けるが、cs-manager で使うのは以下 2 種のみ (origin-core mall_code_definitions 実データで裏取り):
 * - identifier_1: rakuten=商品管理番号 (複数子SKUで共有され曖昧) / amazon=親ASIN
 * - identifier_2: rakuten=SKU管理番号 (子 product 一意) / amazon=子ASIN
 *   (Core SDK amazonAsinMap も ASIN 逆引きは identifier_2 固定 — 同一契約)
 */
export type MallIdentifierSlot = 'identifier_1' | 'identifier_2';

/**
 * モール識別子 (商品管理番号/SKU管理番号/ASIN 等) → Core product_id の一括逆引き。
 *
 * - エンドポイント: GET /api/v1/master/mall-identifiers/lookup-bulk?mallCode=&slot=&values=CSV
 * - mallCode の実値は Core malls.code (例: 'amazon' / 'rakuten' / 'yahoo')。
 * - slot はモール×検索キーごとに正しいスロットを呼出側が指定する (MallIdentifierSlot 参照)。
 *   例: Amazon の子ASIN 逆引きは identifier_2 (identifier_1=親ASIN だと多バリエーション品が全 miss)。
 * - レスポンス envelope は Core sendData 形 `{data: {value: {coreProductId, mallIdentifierId} | null}}`
 *   (origin-core lookupMallIdentifiersBulkFromCore の戻り形)。null (未ヒット) は Map に含めない。
 * - values は重複除去し MAX_BULK(500) ごとにチャンク分割して順次取得。
 *   CSV 契約のため ',' を含む値は逆引き不能なので事前に除外する (未解決扱い)。
 *
 * 失敗時 (env 未設定 / 非 2xx / network) は throw する (戻り型に error チャネルが無いため)。
 * 呼出側 (sales-resolver) で catch し「販売数取得不可」フォールバックへ落とすこと。
 */
export async function lookupMallIdentifiersBulk(
  mallCode: string,
  slot: MallIdentifierSlot,
  values: string[],
): Promise<Map<string, { productId: string }>> {
  const result = new Map<string, { productId: string }>();

  // 重複・空・CSV 非対応値 (',' 含み) を除外
  const uniqueValues = Array.from(
    new Set(
      values
        .map((v) => v.trim())
        .filter((v) => v.length > 0 && !v.includes(',')),
    ),
  );
  if (uniqueValues.length === 0) return result;

  // env は call-time 解決 (テスト時の env 上書き順序に依存しないため)
  const coreApiUrl = process.env.CORE_API_URL?.replace(/\s+$/, '');
  if (!coreApiUrl) {
    throw new Error('CORE_API_URL is not set');
  }
  const entryKeys = getEntryKeys();
  if (entryKeys.length === 0) {
    throw new Error('CORE_CREDENTIAL_KEY is not set');
  }
  const base = coreApiUrl.replace(/\/$/, '');

  for (const chunk of chunkValues(uniqueValues, MALL_LOOKUP_MAX_BULK)) {
    const url =
      `${base}/api/v1/master/mall-identifiers/lookup-bulk` +
      `?mallCode=${encodeURIComponent(mallCode)}` +
      `&slot=${encodeURIComponent(slot)}` +
      `&values=${encodeURIComponent(chunk.join(','))}`;

    const response = await fetchWithEntryKeys(
      url,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(CORE_API_TIMEOUT_MS),
      },
      { entryKeys },
    );

    if (!response.ok) {
      // 非 2xx の body は反射しない (status のみ)。
      try { await response.arrayBuffer(); } catch { /* ignore */ }
      throw new Error(`Core API error: ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as {
      data?: Record<string, { coreProductId?: number } | null>;
    };
    const data = body?.data ?? {};
    for (const [value, hit] of Object.entries(data)) {
      if (hit && hit.coreProductId != null) {
        result.set(value, { productId: String(hit.coreProductId) });
      }
    }
  }

  return result;
}
