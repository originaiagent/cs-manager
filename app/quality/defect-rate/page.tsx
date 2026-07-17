import { unstable_noStore as noStore } from 'next/cache';
import Link from 'next/link';
import { AlertTriangle, ChevronRight, ChevronLeft as ChevronLeftIcon, ChevronRight as ChevronRightIcon } from 'lucide-react';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import { resolveProductsByIds, resolveProductGroupsByIds } from '@/lib/product-resolver';
import { formatPercent } from '@/lib/format';
import EmptyState from '@/components/ui/empty-state';
import { chunkValues } from '@/lib/core-client';
import {
  PERIODS,
  PERIOD_LABELS,
  GRANULARITIES,
  GRANULARITY_LABELS,
  type Period,
  type Granularity,
  type DateRange,
  clampMonth,
  currentMonthKey,
  prevMonth,
  nextMonth,
  resolvePeriodRange,
  resolveCustomRange,
  dateRangeToUtcIso,
} from '@/lib/quality/period';
import { fetchCustomerReturns } from '@/lib/ec-manager/client';
import { splitReturnsByReason } from '@/lib/quality/return-reasons';
import { normalizeMajorCategory } from '@/lib/quality/defect-taxonomy';
import { resolveSalesUnits, resolveAmazonAsins } from '@/lib/quality/sales-resolver';
import {
  aggregateDefectCases,
  extractOrderNumberFromChannelMeta,
  type DefectTicketInput,
  type DefectCsrInput,
  type FbaDefectReturnInput,
  type DefectAggRow,
  type TicketCauseInput,
} from '@/lib/quality/defect-aggregate';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;

const DEFAULT_THRESHOLD = (() => {
  const env = process.env.DEFECT_RATE_THRESHOLD_DEFAULT?.replace(/\s+$/, '');
  if (!env) return 0.05;
  const n = parseFloat(env);
  return isFinite(n) && n > 0 ? n : 0.05;
})();

const VARIATION_UNKNOWN_LABEL = '(バリエーション不明)';

/** Supabase `.in()` の 1 回あたり最大 id 数 (URL 長対策) */
const IN_CHUNK_SIZE = 100;

interface SearchParams {
  period?: string;
  month?: string;
  granularity?: string;
  from?: string;
  to?: string;
}

/** 期間モード: 既存 Period + カスタム期間 (?period=custom&from=&to=) */
type PeriodMode = Period | 'custom';

export default async function DefectRatePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  noStore();

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
  const monthKey = mode === 'monthly' ? clampMonth(searchParams.month) : null;
  const range: DateRange = customRange ?? resolvePeriodRange(mode as Period, monthKey);
  const { startUtc, endUtc } = dateRangeToUtcIso(range);

  const sb = await getSupabaseAdmin();

  // 1) tickets defect
  //    product_id 無しの ticket も取得する (CSR.ticket_id 統合で製品が解決され得るため。
  //    最終的に製品未特定のまま残った案件は「製品未特定」注記に計上)
  const { data: defectTickets } = await sb
    .from('tickets')
    .select('id, product_id, defect_type, channel_id, channel_meta')
    .eq('case_category', 'defect')
    .gte('created_at', startUtc)
    .lt('created_at', endUtc);
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
      'id, ticket_id, product_id, variation_id, variation_text, action_type, defect_type, order_number, order_channel',
    )
    .gte('record_date', range.start)
    .lte('record_date', range.end);
  const defectCsrs = (csrRows ?? []).filter((r: any) => {
    if (r.action_type === 'reship_defect' || r.action_type === 'refund_defect') return true;
    const dt = (r.defect_type ?? '').toString().trim();
    return dt !== '';
  });

  // 3) 分母: ec-manager 販売実績 → Core 名寄せ (sales_stats_cache は読まない)
  const salesRes = await resolveSalesUnits(range);

  // 4) FBA 返品 (理由コード付き) → 不良系 / 顧客都合 / 未分類に振り分け
  const returnsRes = await fetchCustomerReturns(range);
  const returnsSplit = returnsRes.ok
    ? splitReturnsByReason(returnsRes.rows ?? [])
    : { defects: [], excluded: [], unclassified: [] };
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

  // 6) 集計 (純関数)
  const ticketInputs: DefectTicketInput[] = ticketRows.map((t: any) => ({
    id: String(t.id),
    product_id: t.product_id != null ? String(t.product_id) : null,
    defect_type: t.defect_type != null ? String(t.defect_type) : null,
    causes: causesByTicket.get(String(t.id)) ?? [],
    order_number: extractOrderNumberFromChannelMeta(t.channel_meta),
    channel_code: channelCodeById.get(String(t.channel_id)) ?? null,
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
  }));
  const fbaInputs: FbaDefectReturnInput[] = returnsSplit.defects.map(({ row, mapping }) => ({
    orderId: row.orderId,
    asin: row.asin,
    quantity: row.quantity,
    causeLabel: mapping.causeLabel,
    majorCategory: mapping.majorCategory,
  }));

  const agg = aggregateDefectCases({
    tickets: ticketInputs,
    csrs: csrInputs,
    fbaReturns: fbaInputs,
    resolution: { asinToChild: amazonRes.asinToChild, childToGroup },
    sales: {
      available: salesRes.ok,
      groupUnits: salesRes.groupUnits,
      variationUnits: salesRes.variationUnits,
      unmappedUnits: salesRes.unmappedUnits,
    },
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

  function pickProductName(id: string): string {
    const g = groups.get(id);
    if (g?.resolved) return g.group_name;
    const p = products.get(id);
    if (p?.resolved) return p.name;
    return `id=${id}`;
  }
  function pickVariationLabel(r: DefectAggRow): string {
    if (r.variation_text) return r.variation_text;
    if (r.variation_child_id) {
      const p = variationProducts.get(r.variation_child_id);
      if (p?.resolved && p.variation) return p.variation;
      return `id=${r.variation_child_id}`;
    }
    return VARIATION_UNKNOWN_LABEL;
  }

  const overThreshold = rows.filter(
    (r) => r.rate != null && (r.sales_units ?? 0) > 0 && r.rate >= DEFAULT_THRESHOLD,
  );

  // 原因ラベルの動的カラム集合 (表ヘッダ。ラベルは既に日本語)
  const causeLabels = Array.from(
    new Set(rows.flatMap((r) => Object.keys(r.cause_breakdown))),
  ).sort((a, b) => a.localeCompare(b, 'ja'));

  const unclassifiedReturns = returnsSplit.unclassified.length;
  const returnsTruncated = returnsRes.ok && returnsRes.truncated === true;
  const hasUnmappedNote =
    agg.unmapped.salesUnits > 0 ||
    agg.unmapped.fbaReturns > 0 ||
    agg.unmapped.defectCases > 0 ||
    unclassifiedReturns > 0;

  const queryStringFor = (overrides: Partial<SearchParams>): string => {
    const sp = new URLSearchParams();
    const p = overrides.period ?? mode;
    sp.set('period', p);
    if (p === 'monthly') {
      sp.set('month', overrides.month ?? monthKey ?? currentMonthKey());
    }
    if (p === 'custom') {
      sp.set('from', overrides.from ?? range.start);
      sp.set('to', overrides.to ?? range.end);
    }
    sp.set('granularity', overrides.granularity ?? granularity);
    return `?${sp.toString()}`;
  };

  return (
    <div>
      {/* 期間 + 粒度 セレクタ */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs text-gray-500 font-medium mr-1">期間</span>
        {(PERIODS as readonly Period[]).map((p) => (
          <Link
            key={p}
            href={`/quality/defect-rate${queryStringFor({ period: p })}`}
            scroll={false}
            data-testid={`period-${p}`}
            className={`inline-flex items-center rounded-full border px-3 py-1.5 text-xs transition-colors ${
              mode === p
                ? 'bg-brand-500 text-white border-brand-500'
                : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
            }`}
          >
            {PERIOD_LABELS[p]}
          </Link>
        ))}

        {mode === 'monthly' && monthKey && (
          <div className="ml-2 flex items-center gap-1">
            {(() => {
              const prev = prevMonth(monthKey);
              return prev ? (
                <Link
                  href={`/quality/defect-rate${queryStringFor({ period: 'monthly', month: prev })}`}
                  scroll={false}
                  className="inline-flex items-center justify-center w-6 h-6 rounded border border-gray-200 bg-white hover:bg-gray-50"
                  aria-label="前月"
                >
                  <ChevronLeftIcon size={12} />
                </Link>
              ) : (
                <span className="inline-flex items-center justify-center w-6 h-6 rounded border border-gray-100 bg-gray-50 text-gray-300">
                  <ChevronLeftIcon size={12} />
                </span>
              );
            })()}
            <span
              data-testid="current-month"
              className="inline-flex items-center rounded border border-gray-200 bg-white px-2 py-1 text-xs tabular-nums text-gray-800"
            >
              {monthKey}
            </span>
            {(() => {
              const nxt = nextMonth(monthKey);
              return nxt ? (
                <Link
                  href={`/quality/defect-rate${queryStringFor({ period: 'monthly', month: nxt })}`}
                  scroll={false}
                  className="inline-flex items-center justify-center w-6 h-6 rounded border border-gray-200 bg-white hover:bg-gray-50"
                  aria-label="翌月"
                >
                  <ChevronRightIcon size={12} />
                </Link>
              ) : (
                <span className="inline-flex items-center justify-center w-6 h-6 rounded border border-gray-100 bg-gray-50 text-gray-300">
                  <ChevronRightIcon size={12} />
                </span>
              );
            })()}
          </div>
        )}

        {/* カスタム期間 (GET form)。既存チップに追加、選択中はハイライト */}
        <form
          method="get"
          action="/quality/defect-rate"
          data-testid="custom-period-form"
          className={`ml-2 flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${
            mode === 'custom' ? 'border-brand-500 bg-brand-50' : 'border-gray-200 bg-white'
          }`}
        >
          <input type="hidden" name="period" value="custom" />
          <input type="hidden" name="granularity" value={granularity} />
          <span className="text-xs text-gray-500">カスタム</span>
          <input
            type="date"
            name="from"
            required
            defaultValue={mode === 'custom' ? range.start : ''}
            data-testid="custom-from"
            className="rounded border border-gray-200 bg-white px-1 py-0.5 text-xs text-gray-700"
          />
          <span className="text-xs text-gray-400">〜</span>
          <input
            type="date"
            name="to"
            required
            defaultValue={mode === 'custom' ? range.end : ''}
            data-testid="custom-to"
            className="rounded border border-gray-200 bg-white px-1 py-0.5 text-xs text-gray-700"
          />
          <button
            type="submit"
            data-testid="custom-apply"
            className="rounded-full bg-brand-500 px-2.5 py-0.5 text-xs text-white hover:bg-brand-600"
          >
            適用
          </button>
        </form>

        <span className="text-xs text-gray-500 font-medium ml-4 mr-1">粒度</span>
        {(GRANULARITIES as readonly Granularity[]).map((g) => (
          <Link
            key={g}
            href={`/quality/defect-rate${queryStringFor({ granularity: g })}`}
            scroll={false}
            data-testid={`granularity-${g}`}
            className={`inline-flex items-center rounded-full border px-3 py-1.5 text-xs transition-colors ${
              granularity === g
                ? 'bg-brand-500 text-white border-brand-500'
                : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
            }`}
          >
            {GRANULARITY_LABELS[g]}
          </Link>
        ))}
      </div>

      {/* 販売数 / FBA 返品の取得不可バナー (ページは落とさない) */}
      {!salesRes.ok && (
        <div
          className="mb-4 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4"
          data-testid="sales-unavailable-banner"
        >
          <AlertTriangle className="text-amber-600 shrink-0 mt-0.5" size={18} />
          <div>
            <p className="text-sm font-semibold text-amber-700">販売数取得不可</p>
            <p className="text-xs text-amber-600 mt-1">
              ec-manager 販売実績 API から分母 (期間販売数) を取得できないため、不良率は表示できません
              ({salesRes.error})。
            </p>
          </div>
        </div>
      )}
      {!returnsRes.ok && (
        <div
          className="mb-4 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4"
          data-testid="returns-unavailable-banner"
        >
          <AlertTriangle className="text-amber-600 shrink-0 mt-0.5" size={18} />
          <div>
            <p className="text-sm font-semibold text-amber-700">FBA 返品取得不可</p>
            <p className="text-xs text-amber-600 mt-1">
              ec-manager 返品 API に接続できないため、FBA 返品由来の不良は集計に含まれていません
              ({returnsRes.error})。
            </p>
          </div>
        </div>
      )}

      {overThreshold.length > 0 && (
        <div className="mb-4 flex items-start gap-3 rounded-lg border border-rose-200 bg-rose-50 p-4">
          <AlertTriangle className="text-rose-600 shrink-0 mt-0.5" size={18} />
          <div>
            <p className="text-sm font-semibold text-rose-700">
              不良率が閾値 ({formatPercent(DEFAULT_THRESHOLD, 1)}) を超えている対象が{' '}
              {overThreshold.length} 件あります
            </p>
            <p className="text-xs text-rose-600 mt-1">
              {overThreshold
                .map((r) => {
                  const name = pickProductName(r.group_id);
                  const label =
                    granularity === 'variation' ? `${name} / ${pickVariationLabel(r)}` : name;
                  return `${label} (${formatPercent(r.rate ?? 0, 1)})`;
                })
                .join(' / ')}
            </p>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState
          title="集計対象のデータがありません"
          description={`対象期間 (${range.start} 〜 ${range.end}) に不良案件・販売実績がいずれもありません`}
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="w-full text-sm" data-testid="defect-rate-table">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium">製品</th>
                {granularity === 'variation' && (
                  <th className="text-left px-4 py-2.5 font-medium">バリエーション</th>
                )}
                <th className="text-right px-4 py-2.5 font-medium">販売数</th>
                <th className="text-right px-4 py-2.5 font-medium">不良数</th>
                <th className="text-right px-4 py-2.5 font-medium">不良率</th>
                {causeLabels.map((label) => (
                  <th key={label} className="text-right px-3 py-2.5 font-medium">
                    {label}
                  </th>
                ))}
                <th className="text-right px-4 py-2.5 font-medium">内訳(t/c/f)</th>
                <th className="text-right px-4 py-2.5 font-medium">対応</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const over =
                  r.rate != null && (r.sales_units ?? 0) > 0 && r.rate >= DEFAULT_THRESHOLD;
                const name = pickProductName(r.group_id);
                const key = `${r.group_id}|${r.variation_child_id ?? r.variation_text ?? '(unknown)'}`;
                return (
                  <tr
                    key={key}
                    data-testid="defect-rate-row"
                    className={`border-t border-gray-100 ${over ? 'bg-rose-50/40' : ''}`}
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">{name}</div>
                      <div className="text-[10px] text-gray-400 mt-0.5">
                        product_id: {r.group_id}
                      </div>
                    </td>
                    {granularity === 'variation' && (
                      <td className="px-4 py-3 text-gray-700">{pickVariationLabel(r)}</td>
                    )}
                    <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                      {r.sales_units != null ? r.sales_units.toLocaleString() : '-'}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                      {r.total_cases}
                    </td>
                    <td
                      className={`px-4 py-3 text-right tabular-nums font-semibold ${
                        over ? 'text-rose-700' : 'text-gray-700'
                      }`}
                    >
                      {r.rate != null ? formatPercent(r.rate, 2) : '-'}
                      {over && (
                        <span className="ml-1 text-[10px] font-medium uppercase tracking-wide">
                          超過
                        </span>
                      )}
                    </td>
                    {causeLabels.map((label) => (
                      <td
                        key={label}
                        className="px-3 py-3 text-right tabular-nums text-gray-600"
                      >
                        {r.cause_breakdown[label] ?? '-'}
                      </td>
                    ))}
                    <td className="px-4 py-3 text-right tabular-nums text-[11px] text-gray-400">
                      {r.sources.tickets}/{r.sources.csr}/{r.sources.fba}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/inbox?product=${encodeURIComponent(r.group_id)}&status=untouched`}
                        className="inline-flex items-center gap-1 text-xs text-brand-700 hover:underline"
                      >
                        チケット <ChevronRight size={12} />
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 未紐付け・未分類の注記 (集計から漏れたものの可視化) */}
      {hasUnmappedNote && (
        <p className="text-[11px] text-gray-500 mt-3" data-testid="unmapped-note">
          ※ 集計対象外:
          {agg.unmapped.salesUnits > 0 && (
            <> 製品未解決の販売数 {agg.unmapped.salesUnits.toLocaleString()} 個 /</>
          )}
          {agg.unmapped.fbaReturns > 0 && (
            <> 製品未解決の FBA 不良返品 {agg.unmapped.fbaReturns} 件 /</>
          )}
          {agg.unmapped.defectCases > 0 && (
            <> 製品未特定の不良案件 {agg.unmapped.defectCases} 件 /</>
          )}
          {unclassifiedReturns > 0 && (
            <> 理由コード未分類の返品 {unclassifiedReturns} 件 (不良にも顧客都合にも数えない) /</>
          )}
        </p>
      )}
      {returnsTruncated && (
        <p className="text-[11px] text-amber-600 mt-1">
          ※ FBA 返品が上限 (5,000 件) で打ち切られています。期間を短くすると全件集計できます。
        </p>
      )}

      <p className="text-[11px] text-gray-400 mt-3">
        ※ 不良率 = 不良案件ユニーク数 ÷ 期間販売数 (全モール、ec-manager 販売実績)。案件 =
        tickets (case_category=defect) + 対応記録 (action_type ∈ reship_defect/refund_defect
        or defect_type 入力あり) + FBA 不良返品 (注文番号一致は同一案件に統合)。原因別は 1
        案件複数原因のため合計 ≠ 不良数。内訳(t/c/f) = チケット/対応記録/FBA返品
        由来の案件数 (重複計上あり)。期間は JST 基準 ({range.start} 〜 {range.end})。閾値{' '}
        {formatPercent(DEFAULT_THRESHOLD, 1)} (env DEFECT_RATE_THRESHOLD_DEFAULT)。
      </p>
    </div>
  );
}
