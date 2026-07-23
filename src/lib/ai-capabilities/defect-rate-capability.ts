import { loadDefectRateData } from '@/lib/quality/defect-rate-data';
import { MAJOR_CATEGORIES, type MajorCategory } from '@/lib/quality/defect-taxonomy';
import {
  matchesProductFilter,
  productFilterOutput,
  resolveProductFilter,
} from '@/lib/ai-capabilities/product-filter';
import {
  bucketCasesByPeriod,
  type BucketGranularity,
} from '@/lib/ai-capabilities/time-buckets';
import type { DefectAggRow } from '@/lib/quality/defect-aggregate';

const DENOMINATOR_SOURCE = 'ec-manager 販売実績 API（対象期間の実売数合計）';

function emptyMajorBreakdown(): Record<MajorCategory, number> {
  return Object.fromEntries(MAJOR_CATEGORIES.map((key) => [key, 0])) as Record<
    MajorCategory,
    number
  >;
}

export async function readDefectRateCapability(sp: URLSearchParams) {
  const filter = await resolveProductFilter({
    product_id: sp.get('product_id'),
    product: sp.get('product'),
  });
  if (!filter.resolved_ok) {
    return { ok: false, product_filter: productFilterOutput(filter), products: [] };
  }

  const granularity: BucketGranularity = sp.get('granularity') === 'week' ? 'week' : 'month';
  const rawLimit = Number(sp.get('limit'));
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) && rawLimit > 0 ? Math.trunc(rawLimit) : 10, 1), 50);
  const from = sp.get('date_from');
  const to = sp.get('date_to');
  const custom = !!from && !!to;
  const data = await loadDefectRateData({
    ...(custom ? { period: 'custom', from: from!, to: to! } : {}),
    granularity: 'variation',
  });
  const matchedRows = data.agg.variationRows.filter((row) => matchesProductFilter(filter, row));
  const products = matchedRows.slice(0, limit).map((row) => mapProduct(row, data, granularity));

  return {
    ok: true,
    period: { from: data.range.start, to: data.range.end, mode: data.mode },
    bucket_granularity: granularity,
    basis: 'occurred' as const,
    basis_date: data.range.end,
    denominator_source: DENOMINATOR_SOURCE,
    sales_ok: data.salesOk,
    ...(data.salesError ? { sales_error: data.salesError } : {}),
    returns_ok: data.returnsOk,
    ...(data.returnsError ? { returns_error: data.returnsError } : {}),
    returns_truncated: data.returnsTruncated,
    product_filter: productFilterOutput(filter),
    limit,
    truncated: matchedRows.length > limit,
    products,
  };
}

function mapProduct(
  row: DefectAggRow,
  data: Awaited<ReturnType<typeof loadDefectRateData>>,
  granularity: BucketGranularity,
) {
  const majorBreakdown = emptyMajorBreakdown();
  for (const [label, count] of Object.entries(row.cause_breakdown)) {
    majorBreakdown[row.cause_majors[label] ?? 'other'] += count;
  }
  const fbaReasons: Record<string, number> = {};
  let uncategorized = 0;
  for (const detail of row.cases) {
    if (detail.causes.length === 0) uncategorized += detail.count;
    const reasonsInCase = new Set<string>();
    for (const cause of detail.causes) {
      if (cause.fbaReason) reasonsInCase.add(cause.fbaReason);
    }
    for (const reason of reasonsInCase) {
      fbaReasons[reason] = (fbaReasons[reason] ?? 0) + detail.count;
    }
  }
  return {
    group_id: row.group_id,
    product_name: data.productNameOf(row.group_id),
    variation_child_id: row.variation_child_id,
    variation: data.variationLabelOf(row),
    numerator_cases: row.total_cases,
    denominator_sales_units: row.sales_units,
    defect_rate: row.rate,
    route_breakdown: row.sources,
    bucket_breakdown: bucketCasesByPeriod(row.cases, data.range, granularity),
    major_category_breakdown: majorBreakdown,
    cause_label_breakdown: row.cause_breakdown,
    fba_reason_breakdown: fbaReasons,
    uncategorized_case_count: uncategorized,
  };
}
