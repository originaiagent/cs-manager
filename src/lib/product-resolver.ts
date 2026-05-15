/**
 * 製品名の名寄せ。Core /api/v1/master/products/{id} を並列に叩く。
 *
 * - キャッシュ: process メモリ Map で 60 秒
 * - 失敗時: id をそのまま name にフォールバック (落とさない)
 * - サーバ専用 (lib/core-client.ts と同じ)
 */

import { fetchProductById } from './core-client';

const CACHE_TTL_MS = 60 * 1000;

interface CacheEntry {
  ts: number;
  name: string;
  variation?: string | null;
  group_name?: string | null;
}

const cache = new Map<string, CacheEntry>();

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
    const entry = cache.get(id);
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
        const entry: CacheEntry = {
          ts: Date.now(),
          name,
          variation: r.product.variation ?? null,
          group_name: r.product.group_name ?? null,
        };
        cache.set(id, entry);
        result.set(id, { id, name, variation: entry.variation, group_name: entry.group_name, resolved: true });
      } else {
        result.set(id, { id, name: `id=${id}`, resolved: false });
      }
    }
  }

  return result;
}
