/**
 * Core 親グループマスタ一覧取得 (全件)。
 * - エンドポイント: GET /api/v1/master/product-groups?limit=N&offset=N&fields=...
 * - meta.total ベース pagination, MAX_GROUPS_FOR_GRID=5000
 * - process メモリ TTL Map で 600秒キャッシュ
 * - shape 防御 (Array / data / products)
 * - サーバ専用
 *
 * 旧 listCoreProducts (子 products 一覧取得) は廃止し、本ファイルで
 * 親階層 product_groups 取得に統一する (PR-EF: Core 親子構造に厳密準拠)。
 */
import 'server-only';
import { getEntryKeys, fetchWithEntryKeys } from '@/lib/core-entry-keys';

const CORE_API_URL = process.env.CORE_API_URL?.replace(/\s+$/, '');
const CORE_API_TIMEOUT_MS = process.env.CORE_API_TIMEOUT_MS
  ? parseInt(process.env.CORE_API_TIMEOUT_MS, 10)
  : 10_000;

const PAGE_LIMIT = 1000;
const MAX_GROUPS_FOR_GRID = 5000;
const TTL_MS = 10 * 60 * 1000;

export interface CoreProductGroupItem {
  id: string; // 文字列で統一 (knowledge_articles.storage_product_id が text のため)
  group_name: string;
  developer?: string | null;
  category?: string | null;
  product_count?: number;
}

interface CacheEntry {
  ts: number;
  items: CoreProductGroupItem[];
  truncated: boolean;
}

const cache = new Map<string, CacheEntry>();

interface ListOpts {
  fields?: string[];
}

export async function listCoreProductGroups(
  opts: ListOpts = {},
): Promise<{ ok: boolean; items: CoreProductGroupItem[]; truncated: boolean; error?: string }> {
  const entryKeys = getEntryKeys();
  if (!CORE_API_URL || entryKeys.length === 0) {
    return {
      ok: false,
      items: [],
      truncated: false,
      error: 'CORE_API_URL / INTERNAL_API_KEY not configured',
    };
  }
  const fields = (opts.fields ?? ['id', 'group_name', 'developer', 'category']).join(',');
  const cacheKey = `fields:${fields}`;
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached && now - cached.ts < TTL_MS) {
    return { ok: true, items: cached.items, truncated: cached.truncated };
  }
  try {
    const base = CORE_API_URL.replace(/\/$/, '');
    const firstUrl = `${base}/api/v1/master/product-groups?limit=${PAGE_LIMIT}&offset=0&fields=${encodeURIComponent(fields)}`;
    const first = await fetchWithEntryKeys(
      firstUrl,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        signal: AbortSignal.timeout(CORE_API_TIMEOUT_MS),
      },
      { entryKeys },
    );
    if (!first.ok) {
      // 非 2xx の body は反射しない (status のみ)。
      try { await first.arrayBuffer(); } catch { /* ignore */ }
      return {
        ok: false,
        items: [],
        truncated: false,
        error: `Core ${first.status}`,
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
      const maxTarget = Math.min(total, MAX_GROUPS_FOR_GRID);
      const offsets: number[] = [];
      for (let off = PAGE_LIMIT; off < maxTarget; off += PAGE_LIMIT) offsets.push(off);
      const pages = await Promise.all(
        offsets.map(async (off): Promise<{ ok: boolean; rows: any[]; error?: string }> => {
          const url = `${base}/api/v1/master/product-groups?limit=${PAGE_LIMIT}&offset=${off}&fields=${encodeURIComponent(fields)}`;
          const r = await fetchWithEntryKeys(
            url,
            {
              method: 'GET',
              headers: { Accept: 'application/json' },
              cache: 'no-store',
              signal: AbortSignal.timeout(CORE_API_TIMEOUT_MS),
            },
            { entryKeys },
          );
          if (!r.ok) {
            // 非 2xx の body は反射しない (status のみ)。
            try { await r.arrayBuffer(); } catch { /* ignore */ }
            return { ok: false, rows: [], error: `offset=${off} ${r.status}` };
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
      if (total > MAX_GROUPS_FOR_GRID) {
        truncated = true;
        // TODO: 10万件規模になったら Core 側 q= サーバ検索 + virtualized list に切替
        console.warn(`[listCoreProductGroups] truncated: total=${total} > MAX=${MAX_GROUPS_FOR_GRID}`);
      }
    }
    const items: CoreProductGroupItem[] = all.map((p) => ({
      id: String(p.id),
      group_name: p.group_name ?? `id=${p.id}`,
      developer: p.developer ?? null,
      category: p.category ?? null,
      product_count: typeof p.product_count === 'number' ? p.product_count : undefined,
    }));
    cache.set(cacheKey, { ts: now, items, truncated });
    return { ok: true, items, truncated };
  } catch (e: any) {
    return { ok: false, items: [], truncated: false, error: e?.message ?? 'unknown' };
  }
}
