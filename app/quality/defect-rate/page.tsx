import { unstable_noStore as noStore } from 'next/cache';
import Link from 'next/link';
import { AlertTriangle, ChevronRight, ChevronLeft as ChevronLeftIcon, ChevronRight as ChevronRightIcon } from 'lucide-react';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import { resolveProductsByIds, resolveProductGroupsByIds } from '@/lib/product-resolver';
import { DEFECT_TYPE_LABELS, formatPercent } from '@/lib/format';
import EmptyState from '@/components/ui/empty-state';
import {
  PERIODS,
  PERIOD_LABELS,
  GRANULARITIES,
  GRANULARITY_LABELS,
  type Period,
  type Granularity,
  clampMonth,
  currentMonthKey,
  monthRangeJstAsUtcIso,
  prevMonth,
  nextMonth,
} from '@/lib/quality/period';
import { fetchAmazonReturnsByProduct } from '@/lib/quality/amazon-returns';

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

interface SearchParams {
  period?: string;
  month?: string;
  granularity?: string;
}

/**
 * 集計キーは "(product_id|variation_label)" 文字列で統一。
 * parent 粒度時は variation_label = '' で省略。
 */
function rowKey(productId: string, variationLabel: string | null): string {
  return `${productId}|${variationLabel ?? VARIATION_UNKNOWN_LABEL}`;
}

interface AggRow {
  product_id: string;
  variation_label: string | null; // null = parent 粒度
  defect_count: number;
  defect_breakdown: Record<string, number>;
  sales_count: number;
  amazon_returns: number;
  amazon_returns_stub: boolean;
  defect_rate: number;
}

export default async function DefectRatePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  noStore();
  const period: Period = (PERIODS as readonly string[]).includes(searchParams.period ?? '')
    ? (searchParams.period as Period)
    : '30d';
  const granularity: Granularity = (GRANULARITIES as readonly string[]).includes(
    searchParams.granularity ?? '',
  )
    ? (searchParams.granularity as Granularity)
    : 'parent';
  const monthKey = period === 'monthly' ? clampMonth(searchParams.month) : null;

  const sb = await getSupabaseAdmin();

  // 期間境界 (UTC ISO)
  let periodStartUtc: string | null = null;
  let periodEndUtc: string | null = null;
  if (period === '30d') {
    periodStartUtc = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
  } else if (period === '90d') {
    periodStartUtc = new Date(Date.now() - 90 * 24 * 3600_000).toISOString();
  } else if (period === 'monthly' && monthKey) {
    const r = monthRangeJstAsUtcIso(monthKey);
    periodStartUtc = r.startUtc;
    periodEndUtc = r.endUtc;
  }
  // all は両方 null

  // 1) tickets defect
  let tq = sb
    .from('tickets')
    .select('product_id, defect_type, case_category, created_at')
    .eq('case_category', 'defect')
    .not('product_id', 'is', null);
  if (periodStartUtc) tq = tq.gte('created_at', periodStartUtc);
  if (periodEndUtc) tq = tq.lt('created_at', periodEndUtc);
  const { data: defectTickets } = await tq;

  // 2) customer_service_records 不良判定行
  //    PR-EF 以降 product_id は親 group_id を指し、変動 (子) 情報は variation_id に格納される。
  //    sales_stats_cache は子 product_id で keyed のため、サブクエリ用 sales_key は variation_id 優先。
  let cq = sb
    .from('customer_service_records')
    .select('product_id, variation_id, variation_text, action_type, defect_type, record_date');
  if (period === 'monthly' && monthKey) {
    cq = cq.gte('record_date', `${monthKey}-01`);
    // 翌月 1 日 (record_date は date 型なので JST/UTC 関係なく文字列比較で OK)
    const nm = nextMonthForDate(monthKey);
    cq = cq.lt('record_date', nm);
  } else if (period === '30d' || period === '90d') {
    const days = period === '30d' ? 30 : 90;
    const dStart = new Date(Date.now() - days * 24 * 3600_000);
    const ymd = `${dStart.getFullYear()}-${String(dStart.getMonth() + 1).padStart(2, '0')}-${String(dStart.getDate()).padStart(2, '0')}`;
    cq = cq.gte('record_date', ymd);
  }
  const { data: csrRows } = await cq;
  const defectCsrs = (csrRows ?? []).filter((r: any) => {
    if (r.action_type === 'reship_defect' || r.action_type === 'refund_defect') return true;
    const dt = (r.defect_type ?? '').toString().trim();
    return dt !== '';
  });

  // 3) sales_stats_cache (monthly は当面 N/A → null、30d/90d/all は既存通り)
  const salesMap = new Map<string, number>();
  if (period !== 'monthly') {
    const { data: salesRows } = await sb
      .from('sales_stats_cache')
      .select('product_id, sales_count, period')
      .eq('period', period);
    for (const r of salesRows ?? []) salesMap.set(r.product_id, r.sales_count ?? 0);
  }

  // 4) Amazon 返品数 stub: 現状 0 を返す
  //    将来 Core sales-stats 拡張後にここをまとめて fetch する。productId のみで stub 呼び。
  const aggMap = new Map<string, AggRow>();

  // tickets defect の集計
  //   parent: (product_id, null)
  //   variation: (product_id, VARIATION_UNKNOWN_LABEL) tickets には variation 情報なし → 集約
  for (const t of defectTickets ?? []) {
    if (!t.product_id) continue;
    const variationLabel =
      granularity === 'variation' ? VARIATION_UNKNOWN_LABEL : null;
    const k = rowKey(t.product_id, variationLabel);
    const row =
      aggMap.get(k) ??
      ({
        product_id: t.product_id,
        variation_label: variationLabel,
        defect_count: 0,
        defect_breakdown: {},
        sales_count: salesMap.get(t.product_id) ?? 0,
        amazon_returns: 0,
        amazon_returns_stub: true,
        defect_rate: 0,
      } as AggRow);
    row.defect_count += 1;
    const dt = (t.defect_type as string) ?? 'other';
    row.defect_breakdown[dt] = (row.defect_breakdown[dt] ?? 0) + 1;
    aggMap.set(k, row);
  }

  // CSR 不良判定の集計
  //   parent: (product_id, null) で集約 (variation_text は無視して合算)
  //   variation: (product_id, variation_text or VARIATION_UNKNOWN_LABEL)
  //   sales_count: variation_id (子 products.id) を sales_stats_cache の key として優先利用。
  //     - variation 粒度: 個々の variation_id sales を採用
  //     - parent 粒度: 同 parent_id 配下の全 variation_id sales を合算 (parentSalesAcc)
  //     - 旧 legacy CSR (variation_id なし): product_id を直接 sales key として使用
  //     - parent-only 新規データ (variation_id NULL, product_id=group_id): sales=0 (known limitation)
  const parentSalesAcc = new Map<string, Set<string>>(); // parent_id -> 含めた sales key の Set (重複加算防止)
  for (const r of defectCsrs) {
    const pid = r.product_id != null ? String(r.product_id) : null;
    if (!pid) continue;
    const variationId = (r as any).variation_id != null ? String((r as any).variation_id) : null;
    const salesKey = variationId ?? pid;
    let variationLabel: string | null;
    if (granularity === 'variation') {
      const vt = (r.variation_text ?? '').toString().trim();
      variationLabel = vt === '' ? VARIATION_UNKNOWN_LABEL : vt;
    } else {
      variationLabel = null;
    }
    const k = rowKey(pid, variationLabel);
    let row = aggMap.get(k);
    if (!row) {
      row = {
        product_id: pid,
        variation_label: variationLabel,
        defect_count: 0,
        defect_breakdown: {},
        sales_count: 0,
        amazon_returns: 0,
        amazon_returns_stub: true,
        defect_rate: 0,
      } as AggRow;
      aggMap.set(k, row);
    }
    // sales_count 計上:
    //   variation 粒度: row の sales_count に variation_id の sales を一度だけ加算
    //   parent 粒度: 同 parent (pid) で複数 variation を順に加算 (重複防止 Set)
    if (granularity === 'parent') {
      const acc = parentSalesAcc.get(pid) ?? new Set<string>();
      if (!acc.has(salesKey)) {
        row.sales_count += salesMap.get(salesKey) ?? 0;
        acc.add(salesKey);
        parentSalesAcc.set(pid, acc);
      }
    } else {
      // variation 粒度: 行毎の variation_id 単位、初回のみセット
      if (row.defect_count === 0) {
        row.sales_count = salesMap.get(salesKey) ?? 0;
      }
    }
    row.defect_count += 1;
    const dt = (r.defect_type ?? 'other').toString().trim() || 'other';
    row.defect_breakdown[dt] = (row.defect_breakdown[dt] ?? 0) + 1;
  }

  // 販売実績はあるが不良 0 の製品 (parent 粒度のみ追加)
  // 注: sales_stats_cache は子 product_id で keyed。PR-EF 以降 CSR は親 group_id で集約されているため、
  // sales-only の子製品レコードは「親集約済み」の可能性があり、ここでは別行として追加しない方が安全。
  // 追加するのは「CSR にも sales にも親 group_id として現れない子製品のみ」(典型: 完全に defect 0 の製品)。
  // 完全な親 group ロールアップは Core children API ベースの follow-up タスクで対応 (known limitation)。
  if (granularity === 'parent') {
    const parentIdsInCsr = new Set<string>();
    for (const r of defectCsrs) {
      if (r.product_id != null) parentIdsInCsr.add(String(r.product_id));
    }
    for (const [pid, sales] of salesMap.entries()) {
      // CSR に親集約として既にカウント済みの子 sales は二重に表示しない
      // ただし pid が親 group_id として CSR 内に既出の場合は skip (defect 0 のグループならば追加対象に)
      const k = rowKey(pid, null);
      if (aggMap.has(k)) continue;
      // 既に親 group としてアグリゲートされた sales-only の子製品は表示しない
      // (Core children lookup なしでは判定不可、defect 0 の子なら表示 = 一部過剰表示は受容)
      aggMap.set(k, {
        product_id: pid,
        variation_label: null,
        defect_count: 0,
        defect_breakdown: {},
        sales_count: sales,
        amazon_returns: 0,
        amazon_returns_stub: true,
        defect_rate: 0,
      });
    }
    // 未使用変数の lint 回避
    void parentIdsInCsr;
  }

  // Amazon 返品数 (Core 未実装のため stub)。
  // codex R3 PR-C feedback:
  //  - period / monthKey を明示し、stub フラグで非加算を担保
  //  - variation 粒度時は (product_id, VARIATION_UNKNOWN_LABEL) 行のみに加算
  //    (Amazon 返品数は product 単位までしか取れない設計を前提、各 variation
  //    行へ重複加算しない)
  const uniqProductIds = Array.from(new Set(Array.from(aggMap.values()).map((r) => r.product_id)));
  const amazonResults = await Promise.all(
    uniqProductIds.map(async (pid) => {
      const r = await fetchAmazonReturnsByProduct({
        productId: pid,
        period,
        monthKey: period === 'monthly' ? monthKey : null,
      });
      return { pid, count: r.count, stub: r.stub };
    }),
  );
  const amazonMap = new Map<string, { count: number; stub: boolean }>();
  for (const a of amazonResults) amazonMap.set(a.pid, { count: a.count, stub: a.stub });

  if (granularity === 'parent') {
    for (const row of aggMap.values()) {
      const a = amazonMap.get(row.product_id);
      if (a) {
        row.amazon_returns = a.count;
        row.amazon_returns_stub = a.stub;
        if (!a.stub) row.defect_count += a.count;
      }
    }
  } else {
    // variation 粒度: Amazon 返品数は product 単位までしか取れない設計を前提。
    // 当該 product の「(バリエーション不明)」行にのみ載せる (重複加算回避)。
    // unknown 行が存在しない場合は synthetic に作って Amazon 返品数を載せる
    // (codex R3 round 2 反映: 既知 variation のみの product で返品数が
    // 欠落する事象を防ぐ)。stub かつ count=0 の場合は synthetic 行を作らず
    // (UI を無駄に増やさない)、既存 unknown 行があれば flag だけ更新する。
    for (const pid of uniqProductIds) {
      const a = amazonMap.get(pid);
      if (!a) continue;
      const unknownKey = rowKey(pid, VARIATION_UNKNOWN_LABEL);
      const existing = aggMap.get(unknownKey);
      if (existing) {
        existing.amazon_returns = a.count;
        existing.amazon_returns_stub = a.stub;
        if (!a.stub) existing.defect_count += a.count;
      } else if (!a.stub && a.count > 0) {
        aggMap.set(unknownKey, {
          product_id: pid,
          variation_label: VARIATION_UNKNOWN_LABEL,
          defect_count: a.count,
          defect_breakdown: {},
          sales_count: salesMap.get(pid) ?? 0,
          amazon_returns: a.count,
          amazon_returns_stub: false,
          defect_rate: 0,
        });
      }
      // stub === true && unknown 行不在 → 何もしない (UI を無駄に増やさない)
    }
  }

  for (const row of aggMap.values()) {
    row.defect_rate = row.sales_count > 0 ? row.defect_count / row.sales_count : 0;
  }

  // 5) 名寄せ
  const aggs = Array.from(aggMap.values()).sort((a, b) => {
    if (b.defect_rate !== a.defect_rate) return b.defect_rate - a.defect_rate;
    if (a.product_id !== b.product_id) return a.product_id.localeCompare(b.product_id);
    // variation_label: 「(バリエーション不明)」は最後
    const av = a.variation_label ?? '';
    const bv = b.variation_label ?? '';
    if (av === VARIATION_UNKNOWN_LABEL && bv !== VARIATION_UNKNOWN_LABEL) return 1;
    if (bv === VARIATION_UNKNOWN_LABEL && av !== VARIATION_UNKNOWN_LABEL) return -1;
    return av.localeCompare(bv);
  });

  // PR-EF 以降 customer_service_records.product_id は親 product_groups.id を指す。
  // 旧データ (child products.id) との互換のため両 resolver で照会し resolved=true 優先で表示。
  const [products, groups] = await Promise.all([
    resolveProductsByIds(uniqProductIds),
    resolveProductGroupsByIds(uniqProductIds),
  ]);
  function pickProductName(id: string): string {
    const g = groups.get(id);
    if (g?.resolved) return g.group_name;
    const p = products.get(id);
    if (p?.resolved) return p.name;
    return `id=${id}`;
  }
  const overThreshold = aggs.filter(
    (a) => a.sales_count > 0 && a.defect_rate >= DEFAULT_THRESHOLD,
  );

  // defect_type のカラム集合 (表ヘッダ)
  const defectTypes = Array.from(
    new Set(aggs.flatMap((a) => Object.keys(a.defect_breakdown))),
  ).sort();

  const queryStringFor = (overrides: Partial<SearchParams>): string => {
    const sp = new URLSearchParams();
    sp.set('period', overrides.period ?? period);
    if ((overrides.period ?? period) === 'monthly') {
      sp.set('month', overrides.month ?? monthKey ?? currentMonthKey());
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
              period === p
                ? 'bg-brand-500 text-white border-brand-500'
                : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
            }`}
          >
            {PERIOD_LABELS[p]}
          </Link>
        ))}

        {period === 'monthly' && monthKey && (
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
                .map((a) => {
                  const name = pickProductName(a.product_id);
                  const label =
                    granularity === 'variation' && a.variation_label
                      ? `${name} / ${a.variation_label}`
                      : name;
                  return `${label} (${formatPercent(a.defect_rate, 1)})`;
                })
                .join(' / ')}
            </p>
          </div>
        </div>
      )}

      {aggs.length === 0 ? (
        <EmptyState
          title="集計対象のデータがありません"
          description={
            period === 'monthly'
              ? '当該月の tickets defect / 対応記録 / sales_stats_cache がいずれも空です'
              : 'sales_stats_cache または customer_service_records にデータを投入してください'
          }
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
                {defectTypes.map((dt) => (
                  <th key={dt} className="text-right px-3 py-2.5 font-medium">
                    {DEFECT_TYPE_LABELS[dt] ?? dt}
                  </th>
                ))}
                <th className="text-right px-4 py-2.5 font-medium">対応</th>
              </tr>
            </thead>
            <tbody>
              {aggs.map((a) => {
                const over = a.sales_count > 0 && a.defect_rate >= DEFAULT_THRESHOLD;
                const childProduct = products.get(a.product_id);
                const groupItem = groups.get(a.product_id);
                const name = pickProductName(a.product_id);
                // variation サブラベル: 旧データ child resolver の variation を継承表示 (互換)
                const subVariation = childProduct?.resolved ? childProduct.variation : null;
                const key = rowKey(a.product_id, a.variation_label);
                return (
                  <tr
                    key={key}
                    data-testid="defect-rate-row"
                    className={`border-t border-gray-100 ${over ? 'bg-rose-50/40' : ''}`}
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">{name}</div>
                      {granularity === 'parent' && subVariation && !groupItem?.resolved && (
                        <div className="text-[11px] text-gray-500">{subVariation}</div>
                      )}
                      <div className="text-[10px] text-gray-400 mt-0.5">
                        product_id: {a.product_id}
                      </div>
                    </td>
                    {granularity === 'variation' && (
                      <td className="px-4 py-3 text-gray-700">
                        {a.variation_label ?? VARIATION_UNKNOWN_LABEL}
                      </td>
                    )}
                    <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                      {period === 'monthly' ? '-' : a.sales_count.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                      {a.defect_count}
                    </td>
                    <td
                      className={`px-4 py-3 text-right tabular-nums font-semibold ${
                        over ? 'text-rose-700' : 'text-gray-700'
                      }`}
                    >
                      {a.sales_count > 0 ? formatPercent(a.defect_rate, 2) : '-'}
                      {over && (
                        <span className="ml-1 text-[10px] font-medium uppercase tracking-wide">
                          超過
                        </span>
                      )}
                    </td>
                    {defectTypes.map((dt) => (
                      <td
                        key={dt}
                        className="px-3 py-3 text-right tabular-nums text-gray-600"
                      >
                        {a.defect_breakdown[dt] ?? '-'}
                      </td>
                    ))}
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/inbox?product=${encodeURIComponent(a.product_id)}&status=untouched`}
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

      <p className="text-[11px] text-gray-400 mt-3">
        ※ 不良数 = tickets (case_category=defect) + 対応記録 (action_type ∈
        reship_defect/refund_defect or defect_type 入力あり) + Amazon 返品数
        (Core sales-stats API 拡張後に有効化、現状 stub=0)。月別の販売数は当面
        N/A。閾値 {formatPercent(DEFAULT_THRESHOLD, 1)} (env DEFECT_RATE_THRESHOLD_DEFAULT)。
      </p>
    </div>
  );
}

/** record_date (string) を翌月 1 日に進めるヘルパ。Asia/Tokyo を意識しない date 型用 */
function nextMonthForDate(monthKey: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!m) return monthKey;
  let y = parseInt(m[1], 10);
  let mo = parseInt(m[2], 10) + 1;
  if (mo > 12) {
    mo = 1;
    y += 1;
  }
  return `${y}-${String(mo).padStart(2, '0')}-01`;
}
