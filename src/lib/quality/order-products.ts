/**
 * 注文番号 → 製品の解決 (症状ハンドオフ: 製品未特定率削減)
 *
 * 楽天チケットの案件は product_id が未入力のまま残ることが大半で (実データで不良案件の
 * 92% が「製品未特定」)、原因は不良症状が UI に載らないこと。注文番号から楽天注文明細
 * (商品管理番号/SKU管理番号) を引き、Core mall_identifiers 経由で製品を逆引きして
 * defect-aggregate の groupId 補完に使う。
 *
 * フロー (sales-resolver.ts と同一設計):
 *   ec-manager /api/external/rakuten-order-items (注文番号→商品管理番号/SKU管理番号)
 *     → 行毎に rowLookupSpec (sales-resolver.ts と同一の楽天 slot 規則を再利用) で検索キー×slot を決定
 *     → Core lookup-bulk ((mall×slot) 毎に 1 回、N+1 回避) で子 product_id へ逆引き
 *     → resolveProductsByIds で 親 group_id へ
 *     → 注文番号単位でグルーピングし、一意に特定できた注文のみ採用
 *
 * 1 注文に複数商品がある場合、どの商品の不良かは特定できない。誤った製品に不良を
 * 帰属させると不良率そのものが壊れるため、一意に特定できる注文だけを紐付ける
 * (同一注文の ec-manager 行が「全て」解決でき、かつ全行が同一 group に解決される
 * 場合のみ「特定できた」扱い)。1 部の行だけ解決できた注文 (例: 3 商品中 1 商品だけ
 * mall_identifiers にヒット) は、未解決分の実際の商品が別 group である可能性を
 * 排除できないため ambiguous 扱いとし、紐付けない (部分解決による誤帰属防止)。
 *
 * - 楽天注文番号以外 (Amazon 等) は対象外 (order-dates.ts の parseRakutenOrderDate で判定。
 *   非楽天は ec-manager rakuten-order-items へ照会しても無意味なため呼ばない)。
 * - 失敗 (ec-manager 不達 / Core lookup 失敗 / 製品解決失敗) は throw せず ok:false
 *   (呼び出し側は「注文番号からの製品補完なし」に縮退。案件自体は落とさない)。
 * - モジュールスコープ 5 分 TTL メモリキャッシュ (同一注文番号集合。ok:true のみキャッシュ)。
 */

import { fetchRakutenOrderItems } from '@/lib/ec-manager/client';
import { lookupMallIdentifiersBulk, type MallIdentifierSlot } from '@/lib/core-client';
import { resolveProductsByIds } from '@/lib/product-resolver';
import { parseRakutenOrderDate } from './order-dates';
import { rowLookupSpec } from './sales-resolver';

const ORDER_PRODUCTS_CACHE_TTL_MS = 5 * 60 * 1000;
// キーはユーザー制御の期間に紐づく注文番号集合のため無上限成長を FIFO で抑止
// (sales-resolver.ts salesCache と同じガード)
const ORDER_PRODUCTS_CACHE_MAX_ENTRIES = 64;

export interface OrderProductHit {
  childId: string | null;
  groupId: string;
}

export interface ResolvedOrderProducts {
  ok: boolean;
  error?: string;
  degraded: boolean;
  /** 注文番号 → 製品 (一意に特定できたもののみ) */
  orderProducts: Map<string, OrderProductHit>;
  /** 子 product_id → 親 group_id (呼び出し側の childToGroup へマージ用) */
  childToGroup: Map<string, string>;
  /** 複数商品を含み製品を一意に特定できなかった注文数 (UI 注記用) */
  ambiguousOrders: number;
}

function emptyResult(ok: boolean, error?: string, degraded = false): ResolvedOrderProducts {
  return {
    ok,
    ...(error ? { error } : {}),
    degraded,
    orderProducts: new Map(),
    childToGroup: new Map(),
    ambiguousOrders: 0,
  };
}

const lookupGroupKey = (spec: { mall: string; slot: MallIdentifierSlot }): string =>
  `${spec.mall}|${spec.slot}`;

/**
 * 注文番号毎の { 合計行数, 解決済み子 product_id 群 } → 製品特定の可否を判定する
 * (純関数・テスト対象)。
 *
 * ルール (部分解決による誤帰属防止):
 *   - 解決済み子が 1 件も無い注文 (mall_identifiers に一切ヒットしない) は
 *     判定材料が無いためスキップする (ambiguous にも計上しない = 従来どおり)。
 *   - 解決済み子が 1 件以上ある注文は、「注文の全行が解決できている
 *     (resolvedChildIds.length === total)」かつ「解決先が全て同一 group」の
 *     両方を満たす場合のみ「一意に特定できた」扱いにする。
 *   - 一部の行だけ解決できた注文 (例: 3 行中 1 行だけヒット) は、未解決分が
 *     別 group の可能性を排除できないため ambiguousOrders に計上し、紐付けない。
 *   - group 判定は親未解決の子を子 id で代用する (sales-resolver と同一規則)。
 */
export function decideOrderProducts(
  rowsByOrder: ReadonlyMap<string, { total: number; resolvedChildIds: string[] }>,
  childToGroup: ReadonlyMap<string, string>,
): { orderProducts: Map<string, OrderProductHit>; ambiguousOrders: number } {
  const orderProducts = new Map<string, OrderProductHit>();
  let ambiguousOrders = 0;
  for (const [orderNumber, { total, resolvedChildIds }] of rowsByOrder) {
    if (resolvedChildIds.length === 0) continue;
    const distinctChildren = Array.from(new Set(resolvedChildIds));
    const groups = new Set(distinctChildren.map((child) => childToGroup.get(child) ?? child));
    const allRowsResolved = resolvedChildIds.length === total;
    if (!allRowsResolved || groups.size > 1) {
      ambiguousOrders += 1;
      continue;
    }
    const groupId = groups.values().next().value as string;
    orderProducts.set(orderNumber, {
      childId: distinctChildren.length === 1 ? distinctChildren[0] : null,
      groupId,
    });
  }
  return { orderProducts, ambiguousOrders };
}

const orderProductsCache = new Map<string, { ts: number; value: ResolvedOrderProducts }>();

/**
 * 注文番号集合 → 製品を解決する。楽天注文番号のみ対象 (非楽天は無視、API 呼び出しなし)。
 * 失敗時は ok:false (throw しない)。同一注文番号集合は 5 分間キャッシュ。
 */
export async function resolveOrderProducts(
  orderNumbers: Iterable<string>,
): Promise<ResolvedOrderProducts> {
  const rakutenOrders = Array.from(
    new Set(
      Array.from(orderNumbers)
        .map((v) => v?.trim())
        .filter((v): v is string => !!v && parseRakutenOrderDate(v) !== null),
    ),
  );
  if (rakutenOrders.length === 0) return emptyResult(true);

  const cacheKey = [...rakutenOrders].sort().join(',');
  const cached = orderProductsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < ORDER_PRODUCTS_CACHE_TTL_MS) return cached.value;
  if (cached) orderProductsCache.delete(cacheKey); // 期限切れは掃除 (成長抑止)

  const fetched = await fetchRakutenOrderItems(rakutenOrders);
  if (!fetched.ok || !fetched.rows) {
    return emptyResult(false, fetched.error ?? 'rakuten-order-items fetch failed', true);
  }

  // (mall × slot) 毎に検索値 distinct (行毎の検索キー×slot は rowLookupSpec が決定。N+1 回避)
  const lookupGroups = new Map<
    string,
    { mall: string; slot: MallIdentifierSlot; values: Set<string> }
  >();
  for (const row of fetched.rows) {
    const spec = rowLookupSpec({
      marketplace: 'rakuten',
      itemManagementNumber: row.itemManagementNumber,
      skuManagementNumber: row.skuManagementNumber,
    });
    if (!spec) continue;
    const key = lookupGroupKey(spec);
    let group = lookupGroups.get(key);
    if (!group) {
      group = { mall: spec.mall, slot: spec.slot, values: new Set<string>() };
      lookupGroups.set(key, group);
    }
    group.values.add(spec.value);
  }

  const valueToChildByGroup = new Map<string, Map<string, { productId: string }>>();
  try {
    for (const [key, group] of lookupGroups) {
      valueToChildByGroup.set(
        key,
        await lookupMallIdentifiersBulk(group.mall, group.slot, Array.from(group.values)),
      );
    }
  } catch (e) {
    return emptyResult(
      false,
      `Core mall-identifiers lookup failed: ${e instanceof Error ? e.message : String(e)}`,
      true,
    );
  }

  // 注文番号 → { 合計行数 (未解決含む), 解決済み子 product_id 群 }
  // (合計行数を保持するのは部分解決による誤帰属を防ぐため。decideOrderProducts 参照)
  const rowsByOrder = new Map<string, { total: number; resolvedChildIds: string[] }>();
  for (const row of fetched.rows) {
    const entry = rowsByOrder.get(row.orderNumber) ?? { total: 0, resolvedChildIds: [] };
    entry.total += 1;
    const spec = rowLookupSpec({
      marketplace: 'rakuten',
      itemManagementNumber: row.itemManagementNumber,
      skuManagementNumber: row.skuManagementNumber,
    });
    const child = spec
      ? valueToChildByGroup.get(lookupGroupKey(spec))?.get(spec.value)?.productId
      : undefined;
    if (child) entry.resolvedChildIds.push(child);
    rowsByOrder.set(row.orderNumber, entry);
  }

  // 子 product_id → 親 group_id (1 回のバッチ呼び出し)
  const allChildIds = new Set<string>();
  for (const { resolvedChildIds } of rowsByOrder.values())
    for (const id of resolvedChildIds) allChildIds.add(id);
  let degraded = false;
  const childToGroup = new Map<string, string>();
  try {
    const products = await resolveProductsByIds(Array.from(allChildIds));
    for (const [childId, p] of products) {
      if (p.resolved && p.group_id) childToGroup.set(childId, p.group_id);
      if (p.degraded) degraded = true;
    }
  } catch (e) {
    return emptyResult(
      false,
      `Core products/by-ids lookup failed: ${e instanceof Error ? e.message : String(e)}`,
      true,
    );
  }

  const { orderProducts, ambiguousOrders } = decideOrderProducts(rowsByOrder, childToGroup);

  const value: ResolvedOrderProducts = {
    ok: true,
    degraded,
    orderProducts,
    childToGroup,
    ambiguousOrders,
  };
  if (orderProductsCache.size >= ORDER_PRODUCTS_CACHE_MAX_ENTRIES) {
    const oldest = orderProductsCache.keys().next().value;
    if (oldest !== undefined) orderProductsCache.delete(oldest);
  }
  orderProductsCache.set(cacheKey, { ts: Date.now(), value });
  return value;
}
