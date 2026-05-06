/**
 * Core API Client
 * 
 * CORE_API_URL / INTERNAL_API_KEY を使用して Core API に接続します。
 * 認証ヘッダ: X-Internal-API-Key
 */

const CORE_API_URL = process.env.CORE_API_URL || 'https://origin-core-465031496778.asia-northeast1.run.app';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

export interface CoreProduct {
  id: string;
  name: string;
  [key: string]: any;
}

export interface FetchProductsResult {
  ok: boolean;
  count: number;
  sample?: CoreProduct;
  error?: string;
}

export async function fetchProducts(limit: number = 1): Promise<FetchProductsResult> {
  if (!INTERNAL_API_KEY) {
    return { ok: false, count: 0, error: 'INTERNAL_API_KEY is not set' };
  }

  const url = `${CORE_API_URL}/api/v1/master/products?limit=${limit}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Internal-API-Key': INTERNAL_API_KEY,
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { 
        ok: false, 
        count: 0, 
        error: `Core API error: ${response.status} ${response.statusText} - ${errorText}` 
      };
    }

    const data = await response.json();
    const products = Array.isArray(data) ? data : (data.products || []);
    
    return {
      ok: true,
      count: products.length,
      sample: products[0],
    };
  } catch (error: any) {
    return {
      ok: false,
      count: 0,
      error: `Network error: ${error.message}`,
    };
  }
}
