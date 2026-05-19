/**
 * Core 商品マスタ一覧取得 (全件)。
 * - エンドポイント: GET /api/v1/master/products?limit=1000&offset=N&fields=...
 * - meta.total ベース pagination, MAX=5000 (10万件規模は別タスク)
 * - process メモリ TTL Map で 600秒キャッシュ
 * - サーバ専用
 */
import 'server-only';

const CORE_API_URL = process.env.CORE_API_URL?.replace(/\s+$/, '');
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY?.replace(/\s+$/, '');
const CORE_API_TIMEOUT_MS = process.env.CORE_API_TIMEOUT_MS
  ? parseInt(process.env.CORE_API_TIMEOUT_MS, 10)
  : 10_000;

const PAGE_LIMIT = 1000;
const MAX_PRODUCTS_FOR_GRID = 5000;
const TTL_MS = 10 * 60 * 1000;

export interface CoreProductListItem {
  id: string; // 文字列で統一 (knowledge_articles.storage_product_id が text のため)
  product_name: string;
  variation: string | null;
  group_name?: string | null;
}

interface CacheEntry {
  ts: number;
  items: CoreProductListItem[];
  truncated: boolean;
}

const cache = new Map<string, CacheEntry>();

interface ListOpts {
  fields?: string[];
}

export async function listCoreProducts(
  opts: ListOpts = {},
): Promise<{ ok: boolean; items: CoreProductListItem[]; truncated: boolean; error?: string }> {
  if (!CORE_API_URL || !INTERNAL_API_KEY) {
    return {
      ok: false,
      items: [],
      truncated: false,
      error: 'CORE_API_URL / INTERNAL_API_KEY not configured',
    };
  }
  const fields = (opts.fields ?? ['id', 'product_name', 'variation', 'group_name']).join(',');
  const cacheKey = `fields:${fields}`;
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached && now - cached.ts < TTL_MS) {
    return { ok: true, items: cached.items, truncated: cached.truncated };
  }
  try {
    // 1回目
    const base = CORE_API_URL.replace(/\/$/, '');
    const firstUrl = `${base}/api/v1/master/products?limit=${PAGE_LIMIT}&offset=0&fields=${encodeURIComponent(fields)}`;
    const first = await fetch(firstUrl, {
      method: 'GET',
      headers: { 'X-Internal-API-Key': INTERNAL_API_KEY, Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(CORE_API_TIMEOUT_MS),
    });
    if (!first.ok) {
      const txt = await first.text();
      return {
        ok: false,
        items: [],
        truncated: false,
        error: `Core ${first.status}: ${txt.slice(0, 200)}`,
      };
    }
    const firstJson = await first.json();
    const firstData: any[] = Array.isArray(firstJson)
      ? firstJson
      : (firstJson?.data ?? firstJson?.products ?? []);
    const total: number = firstJson?.meta?.total ?? firstData.length;
    let all: any[] = [...firstData];
    let truncated = false;
    if (total > PAGE_LIMIT) {
      const maxTarget = Math.min(total, MAX_PRODUCTS_FOR_GRID);
      const offsets: number[] = [];
      for (let off = PAGE_LIMIT; off < maxTarget; off += PAGE_LIMIT) offsets.push(off);
      const pages = await Promise.all(
        offsets.map(async (off): Promise<{ ok: boolean; rows: any[]; error?: string }> => {
          const url = `${base}/api/v1/master/products?limit=${PAGE_LIMIT}&offset=${off}&fields=${encodeURIComponent(fields)}`;
          const r = await fetch(url, {
            method: 'GET',
            headers: { 'X-Internal-API-Key': INTERNAL_API_KEY, Accept: 'application/json' },
            cache: 'no-store',
            signal: AbortSignal.timeout(CORE_API_TIMEOUT_MS),
          });
          if (!r.ok) {
            const txt = await r.text().catch(() => '');
            return { ok: false, rows: [], error: `offset=${off} ${r.status}: ${txt.slice(0, 120)}` };
          }
          const j = await r.json();
          const rows = Array.isArray(j) ? j : (j?.data ?? j?.products ?? []);
          return { ok: true, rows };
        }),
      );
      const failed = pages.find((p) => !p.ok);
      if (failed) {
        // 部分結果は cache せず、UI でエラー表示できるよう ok:false を返す
        return { ok: false, items: [], truncated: false, error: `paginated fetch failed: ${failed.error}` };
      }
      for (const p of pages) all = all.concat(p.rows);
      if (total > MAX_PRODUCTS_FOR_GRID) {
        truncated = true;
        // TODO: 10万件規模になったら Core 側 q= サーバ検索 + virtualized list に切替
        console.warn(`[listCoreProducts] truncated: total=${total} > MAX=${MAX_PRODUCTS_FOR_GRID}`);
      }
    }
    const items: CoreProductListItem[] = all.map((p) => ({
      id: String(p.id),
      product_name: p.product_name ?? `id=${p.id}`,
      variation: p.variation ?? null,
      group_name: p.group_name ?? null,
    }));
    cache.set(cacheKey, { ts: now, items, truncated });
    return { ok: true, items, truncated };
  } catch (e: any) {
    return { ok: false, items: [], truncated: false, error: e?.message ?? 'unknown' };
  }
}
