/**
 * 期間販売数の解決 (不良発生率の分母)
 *
 * フロー (defect-rate-design.md C2-2):
 *   ec-manager /api/external/sales-units (marketplace×item×sku 集計済)
 *     → 行毎にモール固有の検索キー×slot を決定 (rowLookupSpec) し distinct
 *     → Core lookup-bulk (lookupMallIdentifiersBulk) で 子 product_id へ逆引き
 *     → resolveProductsByIds で 親 group_id へ
 *     → { 親 group 別 units 合計, 子バリエーション別 units }
 *
 * - marketplace → Core mallCode: ec-manager MARKETPLACE_CODES と Core malls.code は
 *   同一の小文字コード (rakuten/amazon/yahoo/qoo10/aupay/shopify) — C1-4 裏取り済み。
 * - 検索キー×slot はモール毎に異なる (rowLookupSpec の doc 参照。mall_code_definitions 裏取り済み)。
 * - 未解決 identifier の units は unmappedUnits へ合算 (UI で注記表示)。
 * - 失敗 (ec-manager 不達 / Core lookup 失敗) は throw せず ok:false
 *   (ページ側で「販売数取得不可」バナー + 分母なし表示)。
 * - モジュールスコープ 5 分 TTL メモリキャッシュ (同一 start/end。ok:true のみキャッシュ)。
 */

import { fetchSalesUnits } from '@/lib/ec-manager/client';
import { lookupMallIdentifiersBulk, type MallIdentifierSlot } from '@/lib/core-client';
import { resolveProductsByIds } from '@/lib/product-resolver';

/** Core malls.code = ec-manager MARKETPLACE_CODES (C1-4 で裏取りした共通小文字コード) */
const SUPPORTED_MALL_CODES = new Set([
  'rakuten',
  'amazon',
  'yahoo',
  'qoo10',
  'aupay',
  'shopify',
]);

const AMAZON_MALL_CODE = 'amazon';

const SALES_CACHE_TTL_MS = 5 * 60 * 1000;

export interface ResolvedSalesUnits {
  ok: boolean;
  error?: string;
  /** 親 group_id → units 合計 (親未解決の子は子 id を group 扱い) */
  groupUnits: Map<string, number>;
  /** 子 product_id → units 合計 */
  variationUnits: Map<string, number>;
  /** 子 product_id → 親 group_id (解決できたもののみ) */
  childToGroup: Map<string, string>;
  /** 製品解決できなかった units 合計 */
  unmappedUnits: number;
}

function emptyResult(ok: boolean, error?: string): ResolvedSalesUnits {
  return {
    ok,
    ...(error ? { error } : {}),
    groupUnits: new Map(),
    variationUnits: new Map(),
    childToGroup: new Map(),
    unmappedUnits: 0,
  };
}

/** marketplace 文字列を Core mallCode へ正規化。未対応モールは null (= 未解決扱い) */
function normalizeMallCode(marketplace: string | null | undefined): string | null {
  const code = marketplace?.trim().toLowerCase();
  if (!code || !SUPPORTED_MALL_CODES.has(code)) return null;
  return code;
}

/** sales 1 行の Core lookup-bulk 検索仕様 (mallCode × slot × 検索値) */
export interface RowLookupSpec {
  mall: string;
  slot: MallIdentifierSlot;
  value: string;
}

/**
 * sales 行 → Core mall_identifiers 逆引きの検索キー×slot を決定する。
 * slot 対応は origin-core mall_code_definitions 実データで裏取り
 * (docs/information-master/pr-a-step2a-investigation.md / Core SDK amazonAsinMap):
 *
 * - amazon: slot1=親ASIN / slot2=子ASIN。sales 行は item/sku とも子ASIN (Business Reports 由来)
 *   → identifier_2 で引く (identifier_1 だと親≠子の多バリエーション品が全 miss = Amazon 分母全滅)。
 * - rakuten: slot1=商品管理番号 (複数子SKUで共有 = 曖昧・任意の1子に解決される) /
 *   slot2=SKU管理番号 (子 product 一意)。SKU管理番号を identifier_2 で引き、
 *   SKU 不在行のみ商品管理番号 identifier_1 へフォールバック
 *   (曖昧解決だが同一 item の子は同一 group のため親粒度の分母は正しい)。
 * - その他モール: item_management_number を identifier_1 で引く (従来通り)。
 *
 * null = 未解決扱い (units は unmappedUnits へ)。
 */
export function rowLookupSpec(row: {
  marketplace: string | null;
  itemManagementNumber: string | null;
  skuManagementNumber: string | null;
}): RowLookupSpec | null {
  const mall = normalizeMallCode(row.marketplace);
  if (!mall) return null;
  const sku = row.skuManagementNumber?.trim() || null;
  const item = row.itemManagementNumber?.trim() || null;
  if (mall === AMAZON_MALL_CODE) {
    const asin = sku ?? item;
    return asin ? { mall, slot: 'identifier_2', value: asin } : null;
  }
  if (mall === 'rakuten') {
    if (sku) return { mall, slot: 'identifier_2', value: sku };
    return item ? { mall, slot: 'identifier_1', value: item } : null;
  }
  return item ? { mall, slot: 'identifier_1', value: item } : null;
}

const lookupGroupKey = (spec: { mall: string; slot: MallIdentifierSlot }): string =>
  `${spec.mall}|${spec.slot}`;

const salesCache = new Map<string, { ts: number; value: ResolvedSalesUnits }>();
// キーはユーザー制御の日付ペア (?period=custom&from=&to=) のため無上限成長を FIFO で抑止
// (credentials/index.ts の CACHE_MAX_ENTRIES と同じガード。エントリが Map 3個と重いため小さめ)
const SALES_CACHE_MAX_ENTRIES = 64;

/**
 * 期間販売数 (親 group 別 / 子バリエーション別) を解決する。
 * 失敗時は ok:false (throw しない)。同一 start/end は 5 分間キャッシュ。
 */
export async function resolveSalesUnits(range: {
  start: string;
  end: string;
}): Promise<ResolvedSalesUnits> {
  const cacheKey = `${range.start}|${range.end}`;
  const cached = salesCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SALES_CACHE_TTL_MS) return cached.value;
  if (cached) salesCache.delete(cacheKey); // 期限切れは掃除 (成長抑止)

  const fetched = await fetchSalesUnits(range);
  if (!fetched.ok || !fetched.rows) {
    return emptyResult(false, fetched.error ?? 'sales-units fetch failed');
  }

  // (mall × slot) 毎に検索値 distinct (行毎の検索キー×slot は rowLookupSpec が決定)
  const lookupGroups = new Map<string, { mall: string; slot: MallIdentifierSlot; values: Set<string> }>();
  for (const row of fetched.rows) {
    const spec = rowLookupSpec(row);
    if (!spec) continue;
    const key = lookupGroupKey(spec);
    let group = lookupGroups.get(key);
    if (!group) {
      group = { mall: spec.mall, slot: spec.slot, values: new Set<string>() };
      lookupGroups.set(key, group);
    }
    group.values.add(spec.value);
  }

  // Core lookup-bulk ((mall × slot) 毎)。失敗は分母なしへフォールバック (fail-soft)
  const valueToChildByGroup = new Map<string, Map<string, { productId: string }>>();
  try {
    for (const [key, group] of lookupGroups) {
      valueToChildByGroup.set(
        key,
        await lookupMallIdentifiersBulk(group.mall, group.slot, Array.from(group.values)),
      );
    }
  } catch (e) {
    // lookupMallIdentifiersBulk のエラーは status のみ (body 反射なし) なのでそのまま載せる
    return emptyResult(
      false,
      `Core mall-identifiers lookup failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // 子 product_id → 親 group_id
  const childIds = new Set<string>();
  for (const m of valueToChildByGroup.values()) {
    for (const hit of m.values()) childIds.add(hit.productId);
  }
  const products = await resolveProductsByIds(Array.from(childIds));
  const childToGroup = new Map<string, string>();
  for (const [childId, p] of products) {
    if (p.resolved && p.group_id) childToGroup.set(childId, p.group_id);
  }

  // units 集計
  const groupUnits = new Map<string, number>();
  const variationUnits = new Map<string, number>();
  let unmappedUnits = 0;
  for (const row of fetched.rows) {
    const unitsRaw = Number(row.units);
    const units = Number.isFinite(unitsRaw) ? unitsRaw : 0;
    const spec = rowLookupSpec(row);
    const child = spec
      ? valueToChildByGroup.get(lookupGroupKey(spec))?.get(spec.value)?.productId
      : undefined;
    if (!child) {
      unmappedUnits += units;
      continue;
    }
    variationUnits.set(child, (variationUnits.get(child) ?? 0) + units);
    // 親未解決の子は子 id を group 扱い (defect-aggregate の groupOf と同一規則)
    const group = childToGroup.get(child) ?? child;
    groupUnits.set(group, (groupUnits.get(group) ?? 0) + units);
  }

  const value: ResolvedSalesUnits = {
    ok: true,
    groupUnits,
    variationUnits,
    childToGroup,
    unmappedUnits,
  };
  if (salesCache.size >= SALES_CACHE_MAX_ENTRIES) {
    const oldest = salesCache.keys().next().value;
    if (oldest !== undefined) salesCache.delete(oldest);
  }
  salesCache.set(cacheKey, { ts: Date.now(), value });
  return value;
}

export interface ResolvedAmazonAsins {
  ok: boolean;
  error?: string;
  /** ASIN lookup 失敗でキャッシュ外 ASIN が未解決のまま残った、または 子 product の
   *  by-ids 取得が一部チャンクで失敗した (ok=true でも一部 ASIN / 製品が未解決になり得る。
   *  工場向けエビデンス画面の縮退注記に使う) */
  degraded: boolean;
  /** ASIN → 子 product_id */
  asinToChild: Map<string, string>;
  /** 子 product_id → 親 group_id (解決できたもののみ) */
  childToGroup: Map<string, string>;
}

/** ASIN→product_id はマスタ対応で事実上不変のため長め TTL (30分) */
const ASIN_CACHE_TTL_MS = 30 * 60 * 1000;
// 母集団はモール横断の全 ASIN で無上限成長し得るため FIFO で抑止 (salesCache と同じ流儀)
const ASIN_CACHE_MAX_ENTRIES = 2000;
/** Core lookup 失敗時の再試行までの待機 (1 回だけ再試行) */
const ASIN_LOOKUP_RETRY_DELAY_MS = 300;

interface AsinCacheEntry {
  ts: number;
  /** Core 未登録 ASIN (null) もキャッシュし、毎回の空振り lookup を防ぐ */
  productId: string | null;
}

const asinCache = new Map<string, AsinCacheEntry>();

/** 新鮮なキャッシュ命中のみ返す。期限切れは読み時に delete (成長抑止) */
function getFreshAsinCacheEntry(asin: string): AsinCacheEntry | undefined {
  const entry = asinCache.get(asin);
  if (!entry) return undefined;
  if (Date.now() - entry.ts >= ASIN_CACHE_TTL_MS) {
    asinCache.delete(asin);
    return undefined;
  }
  return entry;
}

function setAsinCacheEntry(asin: string, productId: string | null): void {
  if (!asinCache.has(asin) && asinCache.size >= ASIN_CACHE_MAX_ENTRIES) {
    const oldest = asinCache.keys().next().value;
    if (oldest !== undefined) asinCache.delete(oldest);
  }
  asinCache.set(asin, { ts: Date.now(), productId });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * FBA 返品行の ASIN 群を 子 product_id / 親 group_id へ解決する
 * (sales-units に現れない ASIN も返品には現れ得るため、販売数解決とは独立に引く)。
 *
 * Core lookup-bulk の一時的な失敗 (429 等) でリロード毎に製品紐付けが揺れる問題への対処:
 * - ASIN → productId をモジュールスコープでキャッシュ (TTL 30分)。キャッシュ新鮮な ASIN は
 *   Core へ問い合わせない。未登録 ASIN (productId=null) もキャッシュする。
 * - キャッシュ外の ASIN のみ Core へ問い合わせ、失敗時は 300ms 待って 1 回だけ再試行。
 * - 2 回とも失敗した場合、その ASIN 群は未解決のまま (キャッシュはしない=次回また試す)。
 *   ただしキャッシュ済み ASIN の結果はそのまま返す (degraded:true, ok は「全滅」時のみ false)。
 */
export async function resolveAmazonAsins(asins: string[]): Promise<ResolvedAmazonAsins> {
  const uniq = Array.from(new Set(asins.map((a) => a.trim()).filter(Boolean)));
  if (uniq.length === 0) {
    return { ok: true, degraded: false, asinToChild: new Map(), childToGroup: new Map() };
  }

  const asinToChild = new Map<string, string>();
  const needLookup: string[] = [];
  for (const asin of uniq) {
    const cached = getFreshAsinCacheEntry(asin);
    if (cached) {
      if (cached.productId) asinToChild.set(asin, cached.productId);
      continue;
    }
    needLookup.push(asin);
  }

  let degraded = false;
  let lookupError: string | undefined;
  if (needLookup.length > 0) {
    let hits: Map<string, { productId: string }> | null = null;
    for (let attempt = 0; attempt < 2 && hits === null; attempt++) {
      if (attempt > 0) await delay(ASIN_LOOKUP_RETRY_DELAY_MS);
      try {
        // 子ASIN は identifier_2 (identifier_1=親ASIN。Core SDK amazonAsinMap と同一契約)
        hits = await lookupMallIdentifiersBulk(AMAZON_MALL_CODE, 'identifier_2', needLookup);
      } catch (e) {
        lookupError = `Core mall-identifiers lookup failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    if (hits) {
      for (const asin of needLookup) {
        const hit = hits.get(asin);
        setAsinCacheEntry(asin, hit ? hit.productId : null);
        if (hit) asinToChild.set(asin, hit.productId);
      }
    } else {
      degraded = true;
    }
  }

  if (degraded && asinToChild.size === 0) {
    // 全滅 (キャッシュ命中も無く lookup も失敗): 従来どおり ok:false
    return {
      ok: false,
      ...(lookupError ? { error: lookupError } : {}),
      degraded: true,
      asinToChild: new Map(),
      childToGroup: new Map(),
    };
  }

  const products = await resolveProductsByIds(Array.from(new Set(asinToChild.values())));
  const childToGroup = new Map<string, string>();
  let productLookupDegraded = false;
  for (const [childId, p] of products) {
    if (p.resolved && p.group_id) childToGroup.set(childId, p.group_id);
    // 子 product 取得が一時障害で欠けた分も縮退として surface する。
    // (立てないと diag が asinResolutionDegraded:false を報告し、静かに製品未解決へ縮退する)
    if (p.degraded) productLookupDegraded = true;
  }

  // lookupError は「初回失敗→再試行成功」でも残るため、縮退時のみ載せる (既存の guard を踏襲)
  const error = degraded && lookupError
    ? lookupError
    : productLookupDegraded
      ? 'Core products/by-ids failed for some product ids'
      : undefined;

  return {
    ok: true,
    ...(error ? { error } : {}),
    degraded: degraded || productLookupDegraded,
    asinToChild,
    childToGroup,
  };
}
