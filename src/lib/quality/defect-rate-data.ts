/**
 * 不良率ページ / CSV エクスポートの共通データローダ — 工場エビデンス化 C3b
 *
 * page.tsx にあった取得パイプライン (tickets / AI 原因 / CSR / 販売数 / FBA 返品 /
 * 製品名寄せ) をここへ集約し、画面 (app/quality/defect-rate/page.tsx) と
 * CSV エクスポート (app/quality/defect-rate/export/route.ts) が同一クエリパラメータで
 * 同一の集計結果を得られるようにする (二重実装によるズレ防止)。
 *
 * 追加 (C3b): ?basis=occurred|ordered (集計基準) を解決。
 * basis='ordered' は「注文日が期間内」の案件を数えるため、発生系レコード
 * (tickets/CSR/FBA 返品) の取得窓を期間終端 +90 日まで広げてから集計側 (range) で絞る
 * (注文から発生までのラグ吸収。C3a-4 契約の方式)。
 */

import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import { resolveProductsByIds, resolveProductGroupsByIds } from '@/lib/product-resolver';
import { chunkValues } from '@/lib/core-client';
import {
  PERIODS,
  GRANULARITIES,
  type Period,
  type Granularity,
  type DateRange,
  clampMonth,
  resolvePeriodRange,
  resolveCustomRange,
  dateRangeToUtcIso,
} from '@/lib/quality/period';
import { fetchCustomerReturns } from '@/lib/ec-manager/client';
import { splitReturnsByReason, fbaReturnKey } from '@/lib/quality/return-reasons';
import { normalizeMajorCategory, type MajorCategory } from '@/lib/quality/defect-taxonomy';
import { resolveSalesUnits, resolveAmazonAsins } from '@/lib/quality/sales-resolver';
import { resolveOrderDates } from '@/lib/quality/order-dates';
import { resolveOrderProducts } from '@/lib/quality/order-products';
import {
  aggregateDefectCases,
  extractOrderNumberFromChannelMeta,
  DEFECT_BASES,
  type DefectBasis,
  type DefectTicketInput,
  type DefectCsrInput,
  type FbaDefectReturnInput,
  type DefectAggRow,
  type DefectAggregateResult,
  type TicketCauseInput,
} from '@/lib/quality/defect-aggregate';

const VARIATION_UNKNOWN_LABEL = '(バリエーション不明)';

/** Supabase `.in()` の 1 回あたり最大 id 数 (URL 長対策) */
const IN_CHUNK_SIZE = 100;

/** basis='ordered' 時に発生系レコードの取得窓を期間終端から前方へ広げる日数 */
const ORDERED_FETCH_FORWARD_DAYS = 90;

/** 期間モード: 既存 Period + カスタム期間 (?period=custom&from=&to=) */
export type PeriodMode = Period | 'custom';

/** page / export が受け取る同一クエリパラメータ */
export interface DefectRateQueryParams {
  period?: string;
  month?: string;
  granularity?: string;
  from?: string;
  to?: string;
  basis?: string;
}

export interface DefectRateData {
  mode: PeriodMode;
  monthKey: string | null;
  /** 集計対象期間 (JST, end inclusive)。basis に依らずユーザーが選んだ期間 */
  range: DateRange;
  granularity: Granularity;
  basis: DefectBasis;
  agg: DefectAggregateResult;
  /** granularity 適用済みの集計行 */
  rows: DefectAggRow[];
  /** 分母 (販売数) 取得可否 (false = 不良率非表示バナー) */
  salesOk: boolean;
  salesError?: string;
  /** FBA 返品取得可否 */
  returnsOk: boolean;
  returnsError?: string;
  returnsTruncated: boolean;
  /** 理由コード未分類の返品件数 (注記用) */
  unclassifiedReturns: number;
  /** 顧客コメントからAI症状分類できた返品行数 */
  returnsWithSymptoms: number;
  /** Amazon 注文日照会 (ec-manager) の失敗 (縮退注記用。楽天パース分は影響なし) */
  amazonLookupFailed: boolean;
  /** Core 製品解決 (ASIN→product) の一時的失敗でキャッシュ外 ASIN が未解決のまま残った
   *  (再読み込みで回復し得る旨の注記用) */
  asinResolutionDegraded: boolean;
  /** 注文番号から製品を特定できた注文数 */
  orderLinkedOrders: number;
  /** 複数商品で製品を一意に特定できなかった注文数 */
  orderAmbiguousOrders: number;
  /** 注文番号→製品の解決が一時障害で縮退したか */
  orderProductsDegraded: boolean;
  /** 親 group_id → 表示名 (Core 名寄せ済み) */
  productNameOf: (groupId: string) => string;
  /** 行のバリエーション表示名 (variation 粒度用) */
  variationLabelOf: (row: DefectAggRow) => string;
}

/** YYYY-MM-DD に日数を加算 (UTC 演算で TZ 非依存。period.ts 私有ヘルパと同流儀) */
function addDaysYmd(ymd: string, days: number): string {
  const [y, mo, d] = ymd.split('-').map((v) => parseInt(v, 10));
  const dt = new Date(Date.UTC(y, mo - 1, d + days));
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${mm}-${dd}`;
}

/** ?basis= の解決 (不正値は既定 'occurred' = 現行どおり発生日基準) */
export function resolveBasis(raw: string | undefined): DefectBasis {
  return (DEFECT_BASES as readonly string[]).includes(raw ?? '')
    ? (raw as DefectBasis)
    : 'occurred';
}

export async function loadDefectRateData(
  searchParams: DefectRateQueryParams,
): Promise<DefectRateData> {
  // --- 期間モード解決: 全モードを [start, end] 日付範囲 (JST) へ正規化 ---
  const requestedPeriod = searchParams.period ?? '';
  const customRange =
    requestedPeriod === 'custom' ? resolveCustomRange(searchParams.from, searchParams.to) : null;
  const mode: PeriodMode = customRange
    ? 'custom'
    : (PERIODS as readonly string[]).includes(requestedPeriod)
      ? (requestedPeriod as Period)
      : '30d';
  const granularity: Granularity = (GRANULARITIES as readonly string[]).includes(
    searchParams.granularity ?? '',
  )
    ? (searchParams.granularity as Granularity)
    : 'parent';
  const basis = resolveBasis(searchParams.basis);
  const monthKey = mode === 'monthly' ? clampMonth(searchParams.month) : null;
  const range: DateRange = customRange ?? resolvePeriodRange(mode as Period, monthKey);

  // 発生系レコードの取得窓: ordered は注文→発生のラグを吸収するため前方 +90 日
  // (期間の絞り込み自体は aggregate 側の range/basis で行う)
  const fetchRange: DateRange =
    basis === 'ordered'
      ? { start: range.start, end: addDaysYmd(range.end, ORDERED_FETCH_FORWARD_DAYS) }
      : range;
  const { startUtc, endUtc } = dateRangeToUtcIso(fetchRange);

  const sb = await getSupabaseAdmin();

  // 1) tickets defect
  //    product_id 無しの ticket も取得する (CSR.ticket_id 統合で製品が解決され得るため。
  //    最終的に製品未特定のまま残った案件は「製品未特定」注記に計上)
  //    limit は PostgREST 暗黙 1000 行上限の顕在化防止 (C3a-4 契約の明示上限)
  const { data: defectTickets } = await sb
    .from('tickets')
    .select('id, product_id, defect_type, channel_id, channel_meta, created_at')
    .eq('case_category', 'defect')
    .gte('created_at', startUtc)
    .lt('created_at', endUtc)
    .limit(5000);
  const ticketRows = defectTickets ?? [];
  const ticketIds = ticketRows.map((t: any) => String(t.id));

  // 1b) AI 分類済み不良原因 (ticket_defect_causes)。
  //     migration 未適用等で読めない場合も落とさない (legacy defect_type フォールバックで継続)
  const causesByTicket = new Map<string, TicketCauseInput[]>();
  for (const chunk of chunkValues(ticketIds, IN_CHUNK_SIZE)) {
    const { data: causeRows } = await sb
      .from('ticket_defect_causes')
      .select('ticket_id, cause_label, major_category')
      .in('ticket_id', chunk);
    for (const row of causeRows ?? []) {
      const tid = String((row as any).ticket_id);
      const label = ((row as any).cause_label ?? '').toString().trim();
      if (!label) continue;
      const list = causesByTicket.get(tid) ?? [];
      list.push({ label, major: normalizeMajorCategory((row as any).major_category) });
      causesByTicket.set(tid, list);
    }
  }

  // 1c) channel code 名寄せ (tickets.channel_id → channels.code)
  const { data: channelRows } = await sb.from('channels').select('id, code');
  const channelCodeById = new Map<string, string>(
    (channelRows ?? []).map((r: any) => [String(r.id), String(r.code)]),
  );

  // 2) customer_service_records 不良判定行 (record_date は date 型 → 文字列比較で inclusive)
  const { data: csrRows } = await sb
    .from('customer_service_records')
    .select(
      'id, ticket_id, product_id, variation_id, variation_text, action_type, defect_type, order_number, order_channel, record_date',
    )
    .gte('record_date', fetchRange.start)
    .lte('record_date', fetchRange.end)
    .limit(5000);
  const defectCsrs = (csrRows ?? []).filter((r: any) => {
    if (r.action_type === 'reship_defect' || r.action_type === 'refund_defect') return true;
    const dt = (r.defect_type ?? '').toString().trim();
    return dt !== '';
  });

  // 3) 分母: ec-manager 販売実績 → Core 名寄せ。分母は order_date 軸のため
  //    basis に依らずユーザー選択期間 (range) のまま
  const salesRes = await resolveSalesUnits(range);

  // 4) FBA 返品 (理由コード付き) → 不良系 / 顧客都合 / 未分類に振り分け
  const returnsRes = await fetchCustomerReturns(fetchRange);
  const returnsSplit = returnsRes.ok
    ? splitReturnsByReason(returnsRes.rows ?? [])
    : { defects: [], excluded: [], unclassified: [] };

  // 4b) 症状ハンドオフ: 顧客コメントAI分類 (fba_return_symptoms) をバッチ取得する。
  //     理由コード由来の粗いラベル (「不良・故障」等) より優先して使う (defect-symptom-handoff)。
  //     N+1 防止のため IN_CHUNK_SIZE 単位でまとめて取得する (per-row query はしない)。
  const returnKeys = Array.from(
    new Set(
      returnsSplit.defects.map(({ row }) =>
        fbaReturnKey({ orderId: row.orderId, sku: row.sku, returnDate: row.returnDate }),
      ),
    ),
  );
  const symptomsByReturnKey = new Map<string, Array<{ label: string; major: MajorCategory }>>();
  for (const chunk of chunkValues(returnKeys, IN_CHUNK_SIZE)) {
    const { data: symptomRows } = await sb
      .from('fba_return_symptoms')
      .select('return_key, cause_label, major_category')
      .in('return_key', chunk);
    for (const row of symptomRows ?? []) {
      const key = String((row as any).return_key);
      const label = ((row as any).cause_label ?? '').toString().trim();
      if (!label) continue;
      const list = symptomsByReturnKey.get(key) ?? [];
      list.push({ label, major: normalizeMajorCategory((row as any).major_category) });
      symptomsByReturnKey.set(key, list);
    }
  }

  const returnAsins = Array.from(
    new Set(
      returnsSplit.defects
        .map(({ row }) => row.asin?.trim() ?? '')
        .filter((a) => a !== ''),
    ),
  );
  const amazonRes = await resolveAmazonAsins(returnAsins);

  // 5) 子 product → 親 group 対応表を統合 (sales 由来 + FBA ASIN 由来 + ticket 子 product 由来)
  const childToGroup = new Map(salesRes.childToGroup);
  for (const [child, group] of amazonRes.childToGroup) {
    if (!childToGroup.has(child)) childToGroup.set(child, group);
  }
  const ticketChildIds = Array.from(
    new Set(
      ticketRows
        .map((t: any) => (t.product_id != null ? String(t.product_id).trim() : ''))
        .filter((id) => id !== '' && !childToGroup.has(id)),
    ),
  );
  const ticketProducts = await resolveProductsByIds(ticketChildIds);
  for (const [childId, p] of ticketProducts) {
    if (p.resolved && p.group_id && !childToGroup.has(childId)) {
      childToGroup.set(childId, p.group_id);
    }
  }

  // 6) 集計入力 (純関数への写像)
  const ticketInputs: DefectTicketInput[] = ticketRows.map((t: any) => ({
    id: String(t.id),
    product_id: t.product_id != null ? String(t.product_id) : null,
    defect_type: t.defect_type != null ? String(t.defect_type) : null,
    causes: causesByTicket.get(String(t.id)) ?? [],
    order_number: extractOrderNumberFromChannelMeta(t.channel_meta),
    channel_code: channelCodeById.get(String(t.channel_id)) ?? null,
    created_at: t.created_at != null ? String(t.created_at) : null,
  }));
  const csrInputs: DefectCsrInput[] = defectCsrs.map((r: any) => ({
    id: String(r.id),
    ticket_id: r.ticket_id != null ? String(r.ticket_id) : null,
    product_id: r.product_id != null ? String(r.product_id) : null,
    variation_id: r.variation_id != null ? String(r.variation_id) : null,
    variation_text: r.variation_text != null ? String(r.variation_text) : null,
    defect_type: r.defect_type != null ? String(r.defect_type) : null,
    order_number: r.order_number != null ? String(r.order_number) : null,
    order_channel: r.order_channel != null ? String(r.order_channel) : null,
    record_date: r.record_date != null ? String(r.record_date) : null,
  }));
  const fbaInputs: FbaDefectReturnInput[] = returnsSplit.defects.map(({ row, mapping }) => {
    const symptoms = symptomsByReturnKey.get(
      fbaReturnKey({ orderId: row.orderId, sku: row.sku, returnDate: row.returnDate }),
    );
    return {
      orderId: row.orderId,
      asin: row.asin,
      quantity: row.quantity,
      causeLabel: mapping.causeLabel,
      majorCategory: mapping.majorCategory,
      returnDate: row.returnDate,
      fbaReason: mapping.fbaReason,
      ...(symptoms && symptoms.length > 0 ? { symptoms } : {}),
    };
  });
  // 顧客コメントからAI症状分類できた返品行数 (診断口・注記用)
  const returnsWithSymptoms = fbaInputs.filter(
    (f) => f.symptoms && f.symptoms.length > 0,
  ).length;

  // 6b) 注文日の解決 (C3a-3)。ドリルダウン/CSV の注文日列と ordered 基準の両方で使う。
  //     楽天はローカルパース、Amazon は ec-manager 照会 (失敗しても落とさず注記)
  const allOrderNumbers = new Set<string>();
  for (const t of ticketInputs) if (t.order_number) allOrderNumbers.add(t.order_number);
  for (const r of csrInputs) if (r.order_number) allOrderNumbers.add(r.order_number);
  for (const f of fbaInputs) if (f.orderId?.trim()) allOrderNumbers.add(f.orderId.trim());
  const orderDatesRes = await resolveOrderDates(allOrderNumbers);

  // 6b-2) 注文番号→製品の解決 (症状ハンドオフ)。product_id 未入力の案件を注文番号から補完する
  //       (楽天注文番号のみ対象。詳細は order-products.ts)
  const orderProductsRes = await resolveOrderProducts(allOrderNumbers);
  for (const [child, group] of orderProductsRes.childToGroup) {
    if (!childToGroup.has(child)) childToGroup.set(child, group);
  }

  // 6c) 集計 (純関数)。range/basis で基準日フィルタ (取得窓の広げ分をここで絞る)
  const agg = aggregateDefectCases({
    tickets: ticketInputs,
    csrs: csrInputs,
    fbaReturns: fbaInputs,
    resolution: {
      asinToChild: amazonRes.asinToChild,
      childToGroup,
      orderProducts: orderProductsRes.orderProducts,
    },
    sales: {
      available: salesRes.ok,
      groupUnits: salesRes.groupUnits,
      variationUnits: salesRes.variationUnits,
      unmappedUnits: salesRes.unmappedUnits,
    },
    basis,
    range,
    orderDates: orderDatesRes.dates,
  });
  const rows: DefectAggRow[] = granularity === 'parent' ? agg.parentRows : agg.variationRows;

  // 7) 名寄せ (親 group 名 / 子バリエーション表示名)
  const groupIds = Array.from(new Set(rows.map((r) => r.group_id)));
  const [products, groups] = await Promise.all([
    resolveProductsByIds(groupIds),
    resolveProductGroupsByIds(groupIds),
  ]);
  const variationChildIds =
    granularity === 'variation'
      ? Array.from(
          new Set(rows.map((r) => r.variation_child_id).filter((v): v is string => v != null)),
        )
      : [];
  const variationProducts = await resolveProductsByIds(variationChildIds);

  const productNameOf = (id: string): string => {
    const g = groups.get(id);
    if (g?.resolved) return g.group_name;
    const p = products.get(id);
    if (p?.resolved) return p.name;
    return `id=${id}`;
  };
  const variationLabelOf = (r: DefectAggRow): string => {
    if (r.variation_text) return r.variation_text;
    if (r.variation_child_id) {
      const p = variationProducts.get(r.variation_child_id);
      if (p?.resolved && p.variation) return p.variation;
      return `id=${r.variation_child_id}`;
    }
    return VARIATION_UNKNOWN_LABEL;
  };

  return {
    mode,
    monthKey,
    range,
    granularity,
    basis,
    agg,
    rows,
    salesOk: salesRes.ok,
    ...(salesRes.error ? { salesError: salesRes.error } : {}),
    returnsOk: returnsRes.ok,
    ...(returnsRes.ok ? {} : { returnsError: returnsRes.error }),
    returnsTruncated: returnsRes.ok && returnsRes.truncated === true,
    unclassifiedReturns: returnsSplit.unclassified.length,
    returnsWithSymptoms,
    amazonLookupFailed: orderDatesRes.amazonLookupFailed,
    asinResolutionDegraded: amazonRes.degraded,
    orderLinkedOrders: orderProductsRes.orderProducts.size,
    orderAmbiguousOrders: orderProductsRes.ambiguousOrders,
    orderProductsDegraded: orderProductsRes.degraded,
    productNameOf,
    variationLabelOf,
  };
}
