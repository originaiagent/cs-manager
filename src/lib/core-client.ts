/**
 * Core API Client
 *
 * origin-core 接続用の薄いラッパー。
 * - 認証: X-Internal-API-Key
 * - URL/Key は env 必須（Fail Fast、ハードコード fallback なし）
 */

const CORE_API_URL = process.env.CORE_API_URL?.replace(/\s+$/, '');
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY?.replace(/\s+$/, '');
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
  if (!INTERNAL_API_KEY) {
    return { ok: false, count: 0, error: 'INTERNAL_API_KEY is not set' };
  }

  const url = `${CORE_API_URL.replace(/\/$/, '')}/api/v1/master/products?limit=${limit}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Internal-API-Key': INTERNAL_API_KEY,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(CORE_API_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        ok: false,
        count: 0,
        error: `Core API error: ${response.status} ${response.statusText} - ${errorText}`,
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
  if (!INTERNAL_API_KEY) {
    return { ok: false, error: 'INTERNAL_API_KEY is not set' };
  }

  const safeId = encodeURIComponent(productId);
  const url = `${CORE_API_URL.replace(/\/$/, '')}/api/v1/master/products/${safeId}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Internal-API-Key': INTERNAL_API_KEY,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(CORE_API_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        ok: false,
        error: `Core API error: ${response.status} ${response.statusText} - ${errorText.slice(0, 300)}`,
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
