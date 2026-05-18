import { unstable_noStore as noStore } from 'next/cache';
import Link from 'next/link';
import { AlertTriangle, ChevronRight } from 'lucide-react';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import { resolveProductsByIds } from '@/lib/product-resolver';
import { DEFECT_TYPE_LABELS, formatPercent } from '@/lib/format';
import EmptyState from '@/components/ui/empty-state';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;

const PERIODS = ['30d', '90d', 'all'] as const;
type Period = (typeof PERIODS)[number];

const PERIOD_LABELS: Record<Period, string> = {
  '30d': '直近30日',
  '90d': '直近90日',
  all: '全期間',
};

const DEFAULT_THRESHOLD = (() => {
  const env = process.env.DEFECT_RATE_THRESHOLD_DEFAULT?.replace(/\s+$/, '');
  if (!env) return 0.05;
  const n = parseFloat(env);
  return isFinite(n) && n > 0 ? n : 0.05;
})();

interface SearchParams {
  period?: string;
}

export default async function DefectRatePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  noStore();
  const period: Period = PERIODS.includes(searchParams.period as Period)
    ? (searchParams.period as Period)
    : '30d';

  const sb = await getSupabaseAdmin();

  const periodCutoff = (() => {
    const now = new Date();
    if (period === '30d') return new Date(now.getTime() - 30 * 24 * 3600_000).toISOString();
    if (period === '90d') return new Date(now.getTime() - 90 * 24 * 3600_000).toISOString();
    return null;
  })();

  // 1) 不良 ticket を製品ごとに集計
  let ticketQ = sb
    .from('tickets')
    .select('product_id, defect_type, case_category, created_at')
    .eq('case_category', 'defect')
    .not('product_id', 'is', null);
  if (periodCutoff) ticketQ = ticketQ.gte('created_at', periodCutoff);
  const { data: defectTickets } = await ticketQ;

  // 2) 販売数を sales_stats_cache から取得
  const { data: salesRows } = await sb
    .from('sales_stats_cache')
    .select('product_id, sales_count, period')
    .eq('period', period);
  const salesMap = new Map<string, number>();
  for (const r of salesRows ?? []) salesMap.set(r.product_id, r.sales_count ?? 0);

  // 3) 製品ごとに集計
  type ProductAgg = {
    product_id: string;
    defect_count: number;
    defect_breakdown: Record<string, number>;
    sales_count: number;
    defect_rate: number;
  };

  const aggMap = new Map<string, ProductAgg>();
  for (const t of defectTickets ?? []) {
    if (!t.product_id) continue;
    const a = aggMap.get(t.product_id) ?? {
      product_id: t.product_id,
      defect_count: 0,
      defect_breakdown: {},
      sales_count: salesMap.get(t.product_id) ?? 0,
      defect_rate: 0,
    };
    a.defect_count += 1;
    const dt: string = (t.defect_type as string) ?? 'other';
    const breakdown = a.defect_breakdown as Record<string, number>;
    breakdown[dt] = (breakdown[dt] ?? 0) + 1;
    aggMap.set(t.product_id, a);
  }
  // 販売実績はあるが不良 0 の製品も対象に含める (現状を見える化)
  for (const [pid, sales] of salesMap.entries()) {
    if (!aggMap.has(pid)) {
      aggMap.set(pid, {
        product_id: pid,
        defect_count: 0,
        defect_breakdown: {},
        sales_count: sales,
        defect_rate: 0,
      });
    }
  }
  for (const a of aggMap.values()) {
    a.defect_rate = a.sales_count > 0 ? a.defect_count / a.sales_count : 0;
  }

  // 4) 製品名を Core から並列に名寄せ
  const aggs = Array.from(aggMap.values()).sort(
    (a, b) => b.defect_rate - a.defect_rate,
  );
  const products = await resolveProductsByIds(aggs.map((a) => a.product_id));

  const overThreshold = aggs.filter((a) => a.defect_rate >= DEFAULT_THRESHOLD);

  // 5) defect_type のカラム集合 (表側ヘッダ用)
  const defectTypes = Array.from(
    new Set(aggs.flatMap((a) => Object.keys(a.defect_breakdown))),
  ).sort();

  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <span className="text-xs text-gray-500 font-medium mr-1">期間</span>
        {PERIODS.map((p) => (
          <Link
            key={p}
            href={`/quality/defect-rate?period=${p}`}
            scroll={false}
            className={`inline-flex items-center rounded-full border px-3 py-1.5 text-xs transition-colors ${
              period === p
                ? 'bg-brand-500 text-white border-brand-500'
                : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
            }`}
          >
            {PERIOD_LABELS[p]}
          </Link>
        ))}
      </div>

      {overThreshold.length > 0 && (
        <div className="mb-4 flex items-start gap-3 rounded-lg border border-rose-200 bg-rose-50 p-4">
          <AlertTriangle className="text-rose-600 shrink-0 mt-0.5" size={18} />
          <div>
            <p className="text-sm font-semibold text-rose-700">
              不良率が閾値 ({formatPercent(DEFAULT_THRESHOLD, 1)}) を超えている製品が{' '}
              {overThreshold.length} 件あります
            </p>
            <p className="text-xs text-rose-600 mt-1">
              {overThreshold
                .map(
                  (a) =>
                    `${products.get(a.product_id)?.name ?? a.product_id} (${formatPercent(a.defect_rate, 1)})`,
                )
                .join(' / ')}
            </p>
          </div>
        </div>
      )}

      {aggs.length === 0 ? (
        <EmptyState
          title="集計対象の販売実績がありません"
          description="sales_stats_cache に当該期間のレコードを投入してください"
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium">製品</th>
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
                const over = a.defect_rate >= DEFAULT_THRESHOLD;
                const product = products.get(a.product_id);
                return (
                  <tr
                    key={a.product_id}
                    className={`border-t border-gray-100 ${over ? 'bg-rose-50/40' : ''}`}
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">
                        {product?.name ?? `id=${a.product_id}`}
                      </div>
                      {product?.variation && (
                        <div className="text-[11px] text-gray-500">{product.variation}</div>
                      )}
                      <div className="text-[10px] text-gray-400 mt-0.5">
                        product_id: {a.product_id}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                      {a.sales_count.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                      {a.defect_count}
                    </td>
                    <td
                      className={`px-4 py-3 text-right tabular-nums font-semibold ${
                        over ? 'text-rose-700' : 'text-gray-700'
                      }`}
                    >
                      {formatPercent(a.defect_rate, 2)}
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
        ※ 販売数は sales_stats_cache (Phase 3.x ガワ seed) を参照。最終段で Core
        /api/v1/master/products/&#123;id&#125;/sales-stats から同期予定。閾値は env
        DEFECT_RATE_THRESHOLD_DEFAULT (現在 {formatPercent(DEFAULT_THRESHOLD, 1)})。
      </p>
    </div>
  );
}
