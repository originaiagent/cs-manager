/**
 * 製品名 / グループ名の名寄せ。Core API を **一括** で叩く。
 *
 * - キャッシュ: process メモリ Map で 60 秒
 * - 失敗時: id をそのまま name にフォールバック (落とさない)
 * - サーバ専用
 *
 * - resolveProductsByIds: 子 product を Core /api/v1/master/products/by-ids で一括解決
 *   (applies_to_products[] 等、子 product id 解決用)
 * - resolveProductGroupsByIds: 親 group を Core /api/v1/master/product-groups 一覧で一括解決
 *   (knowledge_articles.storage_product_id 親階層対応 = PR-EF)
 * - resolveGroupChildIds: 親 group → 子 products.id を Core /api/v1/master/products 一覧で一括解決
 *
 * N+1 撲滅 (不良数が全製品 0 になる事故の根治):
 *   旧実装は id 1 件 = Core 1 リクエストを無制限並列で投げていた (200 商品で 200 本同時)。
 *   1 ページ描画で数百リクエストになり Core が 429 を返す → どの解決が落ちるかがランダムになり、
 *   本番 (Vercel serverless = 毎回コールドでキャッシュ空) では ASIN→product 解決が全滅して
 *   FBA 不良が全件「製品未解決」= 不良数 0 になっていた。
 *   一括口 (by-ids / 一覧) へ寄せ、Core 呼び出しを N 本 → ceil(N/500) 本 (一覧は 1 本) に減らす。
 *   併せて fetchWithEntryKeys 側で同時実行制限 + 429 リトライを掛けている。
 *   **キャッシュはリクエスト跨ぎで効かない前提 (serverless) で、1 リクエスト内で完結させる。**
 */

import { fetchProductById, fetchProductsByIds } from './core-client';
import { getEntryKeys, fetchWithEntryKeys } from '@/lib/core-entry-keys';

const CACHE_TTL_MS = 60 * 1000;

/** Core マスタ一覧のページサイズ (core-products-list.ts の PAGE_LIMIT と同値・流儀踏襲) */
const PAGE_LIMIT = 1000;

/** 一覧取得の安全上限 (core-products-list.ts の MAX_GROUPS_FOR_GRID と同流儀) */
const MAX_LIST_ROWS = 5000;

/** env は call-time 解決 (テスト時の env 上書き順序に依存しないため。core-client と同流儀) */
function coreApiBase(): string | null {
  const url = process.env.CORE_API_URL?.replace(/\s+$/, '');
  return url ? url.replace(/\/$/, '') : null;
}

function coreApiTimeoutMs(): number {
  const raw = process.env.CORE_API_TIMEOUT_MS;
  const n = raw ? parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : 10_000;
}

/**
 * Core マスタ一覧のページング取得 (meta.total ベース)。失敗時は null (呼出側で fallback)。
 * core-products-list.ts と同じ流儀だが、あちらは 'server-only' を持ち import 境界が異なるため
 * (テスト/非 RSC 経路から使えない) 本ファイルに同流儀の実装を置く。
 */
async function fetchCoreListRows(
  path: string,
  fields: string[],
): Promise<any[] | null> {
  const base = coreApiBase();
  const entryKeys = getEntryKeys();
  if (!base || entryKeys.length === 0) return null;
  const fieldsParam = encodeURIComponent(fields.join(','));
  const rows: any[] = [];
  try {
    for (let offset = 0; offset < MAX_LIST_ROWS; offset += PAGE_LIMIT) {
      const url = `${base}${path}?limit=${PAGE_LIMIT}&offset=${offset}&fields=${fieldsParam}`;
      const r = await fetchWithEntryKeys(
        url,
        {
          method: 'GET',
          headers: { Accept: 'application/json' },
          cache: 'no-store',
          signal: AbortSignal.timeout(coreApiTimeoutMs()),
        },
        { entryKeys },
      );
      if (!r.ok) {
        // 非 2xx の body は反射しない (status のみ)。部分結果は使わず fallback へ。
        try { await r.arrayBuffer(); } catch { /* ignore */ }
        return null;
      }
      const j = await r.json();
      const page = Array.isArray(j) ? j : (j?.data ?? []);
      if (!Array.isArray(page)) return null;
      rows.push(...page);
      const total = typeof j?.meta?.total === 'number' ? j.meta.total : rows.length;
      // 全件取得済 / 空ページ (これ以上進まない) なら終了
      if (page.length === 0 || rows.length >= Math.min(total, MAX_LIST_ROWS)) break;
    }
  } catch {
    return null;
  }
  return rows;
}

interface ProductCacheEntry {
  ts: number;
  name: string;
  variation?: string | null;
  group_name?: string | null;
  group_id?: string | null;
}

const productCache = new Map<string, ProductCacheEntry>();

export interface ResolvedProduct {
  id: string;
  name: string;
  variation?: string | null;
  group_name?: string | null;
  group_id?: string | null;
  resolved: boolean;
  /**
   * resolved:false の理由が **Core 取得失敗 (一時障害)** であること。
   * 未設定 = Core が正常応答した上で当該 id を返さなかった (= 存在しない product) か、
   * そもそも Core へ投げない不正 id。縮退注記の surface 用 (resolveAmazonAsins → diag/UI)。
   */
  degraded?: boolean;
}

/**
 * Core products/by-ids が受理する id か (正整数のみ)。
 * Core は 1 件でも不正値があるとチャンク全体を 400 にするため、事前に弾いて未解決扱いにする
 * (旧 per-id 実装では不正 id 1 件が他 id を巻き込まなかった。その挙動を保つ)。
 */
function isCoreProductId(id: string): boolean {
  return /^[1-9][0-9]*$/.test(id);
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
        group_id: entry.group_id,
        resolved: true,
      });
    } else {
      toFetch.push(id);
    }
  }

  if (toFetch.length > 0) {
    // Core が受理しない id は投げない (不正値 1 件でチャンク全体を 400 にしないため)
    const fetchable: string[] = [];
    for (const id of toFetch) {
      if (isCoreProductId(id)) fetchable.push(id);
      else result.set(id, { id, name: `id=${id}`, resolved: false });
    }

    if (fetchable.length > 0) {
      // N 本 → ceil(N/500) 本の一括取得 (N+1 撲滅の要)
      const r = await fetchProductsByIds(fetchable);
      // **ok=false (一部チャンク失敗) でも成功チャンク分は必ず使う**。
      // 1 チャンクの一時失敗で全 id を未解決にすると childToGroup が空になり
      // 「不良数が全製品 0」へ逆戻りするため、失敗は failedIds の id だけに閉じ込める
      // (旧 per-id 実装の失敗隔離と同じ粒度)。
      const byId = new Map<string, { product_name?: string; variation?: string | null; group_name?: string | null; product_group_id?: unknown }>();
      for (const p of r.products ?? []) byId.set(String(p.id), p);
      // failedIds 不在で ok=false = チャンク実行前の失敗 (env 未設定) → 全件が取得失敗
      const failedIds = new Set(r.failedIds ?? (r.ok ? [] : fetchable));

      for (const id of fetchable) {
        const product = byId.get(id);
        if (!product) {
          // Core が返さなかった id は未解決 (現行と同じ)。
          // 一時障害 (失敗チャンク) 由来なら degraded を立てて「存在しない」と区別する。
          result.set(id, {
            id,
            name: `id=${id}`,
            resolved: false,
            ...(failedIds.has(id) ? { degraded: true } : {}),
          });
          continue;
        }
        const name = product.product_name ?? `id=${id}`;
        const groupId =
          product.product_group_id != null ? String(product.product_group_id) : null;
        const entry: ProductCacheEntry = {
          ts: Date.now(),
          name,
          variation: product.variation ?? null,
          group_name: product.group_name ?? null,
          group_id: groupId,
        };
        productCache.set(id, entry);
        result.set(id, {
          id,
          name,
          variation: entry.variation,
          group_name: entry.group_name,
          group_id: groupId,
          resolved: true,
        });
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
  const base = coreApiBase();
  const entryKeys = getEntryKeys();
  if (!base || entryKeys.length === 0) {
    return { ok: false, error: 'CORE_API_URL / CORE_CREDENTIAL_KEY not configured' };
  }
  const safeId = encodeURIComponent(id);
  const url = `${base}/api/v1/master/product-groups/${safeId}`;
  try {
    const r = await fetchWithEntryKeys(
      url,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        signal: AbortSignal.timeout(coreApiTimeoutMs()),
      },
      { entryKeys },
    );
    if (!r.ok) {
      // 非 2xx の body は反射しない (status のみ)。
      try { await r.arrayBuffer(); } catch { /* ignore */ }
      return { ok: false, error: `Core ${r.status}` };
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

/**
 * 親 group ID 配下の子 products.id 一覧を解決。
 * defect-rate などで「親 group 全体の sales 集約」用に使う。
 * 60 秒キャッシュ。失敗時は空配列 fallback。
 */
const groupChildrenCache = new Map<string, { ts: number; childIds: string[] }>();

/** 親 group_id → 子 products.id[] の索引 (60 秒キャッシュ) */
let groupChildIndexCache: { ts: number; byParent: Map<string, string[]> } | null = null;

/**
 * 子 products 一覧 (id, product_group_id) を 1 回引いて 親→子 に索引する。失敗時は null。
 *
 * **product-groups 一覧は include=products に非対応** (origin-core masterV1 の list ハンドラは
 * include を解釈せず、getProductGroupsFromCore も products を select しない。実 API でも
 * `?include=products` / `fields=id,products` 双方で products が返らないことを確認済)。
 * include=products が効くのは単体 /product-groups/:id のみ = per-id N+1 になる。
 * そのため products 一覧の product_group_id から逆向きに索引する (1 リクエストで全親分)。
 */
async function loadGroupChildIndex(): Promise<Map<string, string[]> | null> {
  const now = Date.now();
  if (groupChildIndexCache && now - groupChildIndexCache.ts < CACHE_TTL_MS) {
    return groupChildIndexCache.byParent;
  }
  const rows = await fetchCoreListRows('/api/v1/master/products', ['id', 'product_group_id']);
  if (!rows) return null;
  const byParent = new Map<string, string[]>();
  for (const row of rows) {
    if (row?.id == null || row?.product_group_id == null) continue;
    const parent = String(row.product_group_id);
    const list = byParent.get(parent);
    if (list) list.push(String(row.id));
    else byParent.set(parent, [String(row.id)]);
  }
  groupChildIndexCache = { ts: now, byParent };
  return byParent;
}

export async function resolveGroupChildIds(parentIds: string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  const uniq = Array.from(new Set(parentIds.filter(Boolean)));
  const now = Date.now();
  const toFetch: string[] = [];
  for (const id of uniq) {
    const cached = groupChildrenCache.get(id);
    if (cached && now - cached.ts < CACHE_TTL_MS) {
      result.set(id, cached.childIds);
    } else {
      toFetch.push(id);
    }
  }
  if (toFetch.length === 0) return result;

  const base = coreApiBase();
  const entryKeys = getEntryKeys();
  if (!base || entryKeys.length === 0) {
    for (const id of toFetch) result.set(id, []);
    return result;
  }

  // 一覧 1 回で全親分を索引 (per-id N+1 の撲滅)
  const index = await loadGroupChildIndex();
  if (index) {
    for (const id of toFetch) {
      const childIds = index.get(id) ?? [];
      groupChildrenCache.set(id, { ts: Date.now(), childIds });
      result.set(id, childIds);
    }
    return result;
  }

  // 一覧が引けない場合のみ per-id fallback (同時実行数は fetchWithEntryKeys のセマフォが抑える)
  const fetched = await Promise.all(
    toFetch.map(async (id) => {
      const url = `${base}/api/v1/master/product-groups/${encodeURIComponent(id)}?include=products&productFields=${encodeURIComponent('id')}`;
      try {
        const r = await fetchWithEntryKeys(
          url,
          {
            method: 'GET',
            headers: { Accept: 'application/json' },
            cache: 'no-store',
            signal: AbortSignal.timeout(coreApiTimeoutMs()),
          },
          { entryKeys },
        );
        if (!r.ok) { try { await r.arrayBuffer(); } catch { /* ignore */ } return { id, childIds: [] }; }
        const j = await r.json();
        const group = j?.data ?? j;
        const products = Array.isArray(group?.products) ? group.products : [];
        return { id, childIds: products.map((p: any) => String(p.id)) };
      } catch {
        return { id, childIds: [] };
      }
    }),
  );
  for (const { id, childIds } of fetched) {
    groupChildrenCache.set(id, { ts: Date.now(), childIds });
    result.set(id, childIds);
  }
  return result;
}

interface GroupIndexRow {
  group_name?: string;
  developer?: string | null;
  category?: string | null;
}

/** group_id → group 属性の索引 (60 秒キャッシュ) */
let productGroupIndexCache: { ts: number; byId: Map<string, GroupIndexRow> } | null = null;

/**
 * product-groups 一覧を 1 回引いて id で索引する (per-id N+1 の撲滅)。失敗時は null。
 * fields は resolveProductGroupsByIds が使う最小集合のみ。
 */
async function loadProductGroupIndex(): Promise<Map<string, GroupIndexRow> | null> {
  const now = Date.now();
  if (productGroupIndexCache && now - productGroupIndexCache.ts < CACHE_TTL_MS) {
    return productGroupIndexCache.byId;
  }
  const rows = await fetchCoreListRows('/api/v1/master/product-groups', [
    'id',
    'group_name',
    'developer',
    'category',
  ]);
  if (!rows) return null;
  const byId = new Map<string, GroupIndexRow>();
  for (const row of rows) {
    if (row?.id == null) continue;
    byId.set(String(row.id), {
      group_name: row.group_name,
      developer: row.developer ?? null,
      category: row.category ?? null,
    });
  }
  productGroupIndexCache = { ts: now, byId };
  return byId;
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
    // 一覧 1 回で全 group を索引 (per-id N+1 の撲滅)。引けない場合のみ per-id fallback。
    const index = await loadProductGroupIndex();
    if (index) {
      for (const id of toFetch) {
        const group = index.get(id);
        if (!group) {
          result.set(id, { id, group_name: `id=${id}`, resolved: false });
          continue;
        }
        const entry: GroupCacheEntry = {
          ts: Date.now(),
          group_name: group.group_name ?? `id=${id}`,
          developer: group.developer ?? null,
          category: group.category ?? null,
        };
        groupCache.set(id, entry);
        result.set(id, {
          id,
          group_name: entry.group_name,
          developer: entry.developer,
          category: entry.category,
          resolved: true,
        });
      }
      return result;
    }

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
