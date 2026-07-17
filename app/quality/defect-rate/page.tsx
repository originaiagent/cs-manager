import { unstable_noStore as noStore } from 'next/cache';
import Link from 'next/link';
import {
  AlertTriangle,
  Download,
  ChevronLeft as ChevronLeftIcon,
  ChevronRight as ChevronRightIcon,
} from 'lucide-react';
import { formatPercent } from '@/lib/format';
import EmptyState from '@/components/ui/empty-state';
import {
  PERIODS,
  PERIOD_LABELS,
  GRANULARITIES,
  GRANULARITY_LABELS,
  type Period,
  type Granularity,
  currentMonthKey,
  prevMonth,
  nextMonth,
} from '@/lib/quality/period';
import { RESPONSIBILITY_LABELS } from '@/lib/quality/defect-taxonomy';
import { DEFECT_BASES, type DefectBasis } from '@/lib/quality/defect-aggregate';
import {
  DEFECT_VIEWS,
  DEFECT_VIEW_LABELS,
  applyViewToRow,
  excludedByResponsibility,
  type DefectView,
} from '@/lib/quality/defect-view';
import {
  loadDefectRateData,
  type DefectRateQueryParams,
} from '@/lib/quality/defect-rate-data';
import DefectRateTable, { type DefectRateTableRow } from './_components/defect-rate-table';
import DefinitionsPanel from './_components/definitions-panel';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;

const DEFAULT_THRESHOLD = (() => {
  const env = process.env.DEFECT_RATE_THRESHOLD_DEFAULT?.replace(/\s+$/, '');
  if (!env) return 0.05;
  const n = parseFloat(env);
  return isFinite(n) && n > 0 ? n : 0.05;
})();

/** 集計基準チップの表示ラベル */
const BASIS_LABELS: Record<DefectBasis, string> = {
  occurred: '発生日',
  ordered: '注文日',
};

export default async function DefectRatePage({
  searchParams,
}: {
  searchParams: DefectRateQueryParams;
}) {
  noStore();

  // データ取得・集計は export route と共通のローダへ集約 (C3b)
  const data = await loadDefectRateData(searchParams);
  const { mode, monthKey, range, granularity, view, basis, agg, rows } = data;

  // 表示行 VM (名寄せ済み・serializable。client component へ渡す)
  const tableRows: DefectRateTableRow[] = rows.map((r) => ({
    rowKey: `${r.group_id}|${r.variation_child_id ?? r.variation_text ?? '(unknown)'}`,
    productName: data.productNameOf(r.group_id),
    variationLabel: granularity === 'variation' ? data.variationLabelOf(r) : null,
    row: r,
  }));

  // 閾値超過判定は view 適用後の率で行う (factory ビューでは工場起因のみの率)
  const overThreshold = tableRows
    .map((t) => ({ t, adjusted: applyViewToRow(t.row, view) }))
    .filter(
      ({ t, adjusted }) =>
        adjusted.rate != null && (t.row.sales_units ?? 0) > 0 && adjusted.rate >= DEFAULT_THRESHOLD,
    );

  // factory ビューの除外内訳 (配送・倉庫 / 自社 / 要精査)
  const excluded = view === 'factory' ? excludedByResponsibility(rows) : null;

  const unclassifiedReturns = data.unclassifiedReturns;
  const hasUnmappedNote =
    agg.unmapped.salesUnits > 0 ||
    agg.unmapped.fbaReturns > 0 ||
    agg.unmapped.defectCases > 0 ||
    unclassifiedReturns > 0;

  const queryStringFor = (overrides: DefectRateQueryParams): string => {
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
    // view / basis は既定値のとき URL に載せない (既存 URL・e2e との互換維持)
    const v = (overrides.view ?? view) as DefectView;
    if (v !== 'all') sp.set('view', v);
    const b = (overrides.basis ?? basis) as DefectBasis;
    if (b !== 'occurred') sp.set('basis', b);
    return `?${sp.toString()}`;
  };

  const chipClass = (active: boolean) =>
    `inline-flex items-center rounded-full border px-3 py-1.5 text-xs transition-colors ${
      active
        ? 'bg-brand-500 text-white border-brand-500'
        : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
    }`;

  return (
    <div>
      {/* 期間 + 粒度 セレクタ */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-xs text-gray-500 font-medium mr-1">期間</span>
        {(PERIODS as readonly Period[]).map((p) => (
          <Link
            key={p}
            href={`/quality/defect-rate${queryStringFor({ period: p })}`}
            scroll={false}
            data-testid={`period-${p}`}
            className={chipClass(mode === p)}
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
          {view !== 'all' && <input type="hidden" name="view" value={view} />}
          {basis !== 'occurred' && <input type="hidden" name="basis" value={basis} />}
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
            className={chipClass(granularity === g)}
          >
            {GRANULARITY_LABELS[g]}
          </Link>
        ))}
      </div>

      {/* 表示切替 (全体/工場起因のみ) + 集計基準 (発生日/注文日) + CSV エクスポート */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs text-gray-500 font-medium mr-1">表示</span>
        {(DEFECT_VIEWS as readonly DefectView[]).map((v) => (
          <Link
            key={v}
            href={`/quality/defect-rate${queryStringFor({ view: v })}`}
            scroll={false}
            data-testid={`view-${v}`}
            className={chipClass(view === v)}
          >
            {DEFECT_VIEW_LABELS[v]}
          </Link>
        ))}
        <span className="text-xs text-gray-500 font-medium ml-4 mr-1">基準</span>
        {(DEFECT_BASES as readonly DefectBasis[]).map((b) => (
          <Link
            key={b}
            href={`/quality/defect-rate${queryStringFor({ basis: b })}`}
            scroll={false}
            data-testid={`basis-${b}`}
            className={chipClass(basis === b)}
          >
            {BASIS_LABELS[b]}
          </Link>
        ))}
        <a
          href={`/quality/defect-rate/export${queryStringFor({})}`}
          data-testid="export-csv"
          className="ml-auto inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
        >
          <Download size={12} />
          CSV エクスポート
        </a>
      </div>

      {/* 販売数 / FBA 返品の取得不可バナー (ページは落とさない) */}
      {!data.salesOk && (
        <div
          className="mb-4 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4"
          data-testid="sales-unavailable-banner"
        >
          <AlertTriangle className="text-amber-600 shrink-0 mt-0.5" size={18} />
          <div>
            <p className="text-sm font-semibold text-amber-700">販売数取得不可</p>
            <p className="text-xs text-amber-600 mt-1">
              ec-manager 販売実績 API から分母 (期間販売数) を取得できないため、不良率は表示できません
              ({data.salesError})。
            </p>
          </div>
        </div>
      )}
      {!data.returnsOk && (
        <div
          className="mb-4 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4"
          data-testid="returns-unavailable-banner"
        >
          <AlertTriangle className="text-amber-600 shrink-0 mt-0.5" size={18} />
          <div>
            <p className="text-sm font-semibold text-amber-700">FBA 返品取得不可</p>
            <p className="text-xs text-amber-600 mt-1">
              ec-manager 返品 API に接続できないため、FBA 返品由来の不良は集計に含まれていません
              ({data.returnsError})。
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
                .map(({ t, adjusted }) => {
                  const label =
                    granularity === 'variation'
                      ? `${t.productName} / ${t.variationLabel}`
                      : t.productName;
                  return `${label} (${formatPercent(adjusted.rate ?? 0, 1)})`;
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
        <DefectRateTable
          rows={tableRows}
          granularity={granularity}
          view={view}
          basis={basis}
          threshold={DEFAULT_THRESHOLD}
        />
      )}

      {/* factory ビュー: 除外した案件数の内訳 (全体との突合用) */}
      {excluded && (
        <p className="text-[11px] text-gray-500 mt-3" data-testid="factory-excluded-note">
          ※ 工場起因のみ表示中。除外: {RESPONSIBILITY_LABELS.logistics} {excluded.logistics} 件 /{' '}
          {RESPONSIBILITY_LABELS.listing} {excluded.listing} 件 / {RESPONSIBILITY_LABELS.unverified}{' '}
          {excluded.unverified} 件
        </p>
      )}

      {/* ordered 基準: 注文日不明の案件は発生日で代用した旨の注記 */}
      {basis === 'ordered' && agg.orderedFallbackCases > 0 && (
        <p className="text-[11px] text-gray-500 mt-1" data-testid="ordered-fallback-note">
          ※ 注文日不明の {agg.orderedFallbackCases} 件は発生日で代用して数えています
          (製品未特定の案件を含む)。
        </p>
      )}

      {/* Amazon 注文日照会 (ec-manager) の縮退注記 */}
      {data.amazonLookupFailed && (
        <p className="text-[11px] text-amber-600 mt-1" data-testid="amazon-lookup-failed-note">
          ※ Amazon 注文日の取得 (ec-manager) に失敗したため、Amazon 注文の注文日は表示できません
          (楽天注文の注文日には影響しません)。
        </p>
      )}

      {/* Core 製品解決 (ASIN→product) の一時的失敗による縮退注記 */}
      {data.asinResolutionDegraded && (
        <p className="text-[11px] text-amber-600 mt-1" data-testid="asin-degraded-note">
          ※ Core 製品解決が一時的に失敗し、FBA返品の一部が製品未解決扱いになっています。
          再読み込みで回復する場合があります。
        </p>
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
      {data.returnsTruncated && (
        <p className="text-[11px] text-amber-600 mt-1">
          ※ FBA 返品が上限 (5,000 件) で打ち切られています。期間を短くすると全件集計できます。
        </p>
      )}

      <p className="text-[11px] text-gray-400 mt-3">
        ※ 期間は JST 基準 ({range.start} 〜 {range.end})。閾値{' '}
        {formatPercent(DEFAULT_THRESHOLD, 1)} (env DEFECT_RATE_THRESHOLD_DEFAULT)。
        数字の定義は下の「この数字の定義」を参照。
      </p>

      {/* 集計定義パネル (C3b-4) */}
      <DefinitionsPanel />
    </div>
  );
}
