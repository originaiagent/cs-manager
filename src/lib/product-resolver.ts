/**
 * 製品名 / グループ名の名寄せ。Core API を並列に叩く。
 *
 * - キャッシュ: process メモリ Map で 60 秒
 * - 失敗時: id をそのまま name にフォールバック (落とさない)
 * - サーバ専用
 *
 * - resolveProductsByIds: 子 product (Core /api/v1/master/products/:id) 解決
 *   (applies_to_products[] 等、子 product id 解決用に残置)
 * - resolveProductGroupsByIds: 親 group (Core /api/v1/master/product-groups/:id) 解決
 *   (knowledge_articles.storage_product_id 親階層対応 = PR-EF)
 */

import { fetchProductById } from './core-client';

const CORE_API_URL = process.env.CORE_API_URL?.replace(/\s+$/, '');
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY?.replace(/\s+$/, '');
const CORE_API_TIMEOUT_MS = process.env.CORE_API_TIMEOUT_MS
  ? parseInt(process.env.CORE_API_TIMEOUT_MS, 10)
  : 10_000;

const CACHE_TTL_MS = 60 * 1000;

interface ProductCacheEntry {
  ts: number;
  name: string;
  variation?: string | null;
  group_name?: string | null;
}

const productCache = new Map<string, ProductCacheEntry>();

export interface ResolvedProduct {
  id: string;
  name: string;
  variation?: string | null;
  group_name?: string | null;
  resolved: boolean;
}

export async function resolveProductsByIds(
  ids: string[],
): Promise<Map<string, ResolvedProduct>> {
  const result = new Map<string, ResolvedProduct>();
  const uniq = Array.from(new Set(ids.filter(Boolean)));

  const now = Date.now();
  const toFetch: string[] = [];

  for (const id of uniq) {
    const entry = productCache.get(id);
    if (entry && now - entry.ts < CACHE_TTL_MS) {
      result.set(id, {
        id,
        name: entry.name,
        variation: entry.variation,
        group_name: entry.group_name,
        resolved: true,
      });
    } else {
      toFetch.push(id);
    }
  }

  if (toFetch.length > 0) {
    const fetched = await Promise.all(
      toFetch.map(async (id) => {
        const r = await fetchProductById(id);
        return { id, r };
      }),
    );
    for (const { id, r } of fetched) {
      if (r.ok && r.product) {
        const name = r.product.product_name ?? `id=${id}`;
        const entry: ProductCacheEntry = {
          ts: Date.now(),
          name,
          variation: r.product.variation ?? null,
          group_name: r.product.group_name ?? null,
        };
        productCache.set(id, entry);
        result.set(id, { id, name, variation: entry.variation, group_name: entry.group_name, resolved: true });
      } else {
        result.set(id, { id, name: `id=${id}`, resolved: false });
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// 親 group resolve (PR-EF: Core 親子構造に厳密準拠)
// ---------------------------------------------------------------------------

interface GroupCacheEntry {
  ts: number;
  group_name: string;
  developer?: string | null;
  category?: string | null;
}

const groupCache = new Map<string, GroupCacheEntry>();

export interface ResolvedProductGroup {
  id: string;
  group_name: string;
  developer?: string | null;
  category?: string | null;
  resolved: boolean;
}

async function fetchProductGroupById(
  id: string,
): Promise<{ ok: boolean; group?: { group_name?: string; developer?: string | null; category?: string | null }; error?: string }> {
  if (!CORE_API_URL || !INTERNAL_API_KEY) {
    return { ok: false, error: 'CORE_API_URL / INTERNAL_API_KEY not configured' };
  }
  const safeId = encodeURIComponent(id);
  const url = `${CORE_API_URL.replace(/\/$/, '')}/api/v1/master/product-groups/${safeId}`;
  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: { 'X-Internal-API-Key': INTERNAL_API_KEY, Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(CORE_API_TIMEOUT_MS),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return { ok: false, error: `Core ${r.status}: ${txt.slice(0, 200)}` };
    }
    const j = await r.json();
    const group = j?.data ?? j;
    if (!group || typeof group !== 'object') {
      return { ok: false, error: 'unexpected shape' };
    }
    return { ok: true, group };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'fetch failed' };
  }
}

export async function resolveProductGroupsByIds(
  ids: string[],
): Promise<Map<string, ResolvedProductGroup>> {
  const result = new Map<string, ResolvedProductGroup>();
  const uniq = Array.from(new Set(ids.filter(Boolean)));

  const now = Date.now();
  const toFetch: string[] = [];

  for (const id of uniq) {
    const entry = groupCache.get(id);
    if (entry && now - entry.ts < CACHE_TTL_MS) {
      result.set(id, {
        id,
        group_name: entry.group_name,
        developer: entry.developer,
        category: entry.category,
        resolved: true,
      });
    } else {
      toFetch.push(id);
    }
  }

  if (toFetch.length > 0) {
    const fetched = await Promise.all(
      toFetch.map(async (id) => {
        const r = await fetchProductGroupById(id);
        return { id, r };
      }),
    );
    for (const { id, r } of fetched) {
      if (r.ok && r.group) {
        const group_name = r.group.group_name ?? `id=${id}`;
        const entry: GroupCacheEntry = {
          ts: Date.now(),
          group_name,
          developer: r.group.developer ?? null,
          category: r.group.category ?? null,
        };
        groupCache.set(id, entry);
        result.set(id, {
          id,
          group_name,
          developer: entry.developer,
          category: entry.category,
          resolved: true,
        });
      } else {
        result.set(id, { id, group_name: `id=${id}`, resolved: false });
      }
    }
  }

  return result;
}
