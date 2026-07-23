import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import { CASE_CATEGORIES, type CaseCategory } from '@/lib/quality/defect-classify';
import { loadDefectRateData } from '@/lib/quality/defect-rate-data';
import { MAJOR_CATEGORIES, type MajorCategory } from '@/lib/quality/defect-taxonomy';
import {
  dateRangeToUtcIso,
  jstTodayYmd,
  resolveCustomRange,
  resolvePeriodRange,
  type DateRange,
} from '@/lib/quality/period';
import {
  matchesProductFilter,
  productFilterOutput,
  resolveProductFilter,
  type ResolvedProductFilter,
} from '@/lib/ai-capabilities/product-filter';
import { previousPeriodRange } from '@/lib/ai-capabilities/period-compare';

type CategoryBreakdown = Record<CaseCategory | 'unclassified', number>;

function emptyCategories(): CategoryBreakdown {
  return Object.fromEntries([...CASE_CATEGORIES, 'unclassified'].map((key) => [key, 0])) as CategoryBreakdown;
}

function emptyMajors(): Record<MajorCategory, number> {
  return Object.fromEntries(MAJOR_CATEGORIES.map((key) => [key, 0])) as Record<MajorCategory, number>;
}

async function countTickets(range: DateRange, filter: ResolvedProductFilter) {
  if (filter.active && filter.childIds.size === 0) {
    return { total: 0, breakdown: emptyCategories() };
  }
  const { startUtc, endUtc } = dateRangeToUtcIso(range);
  const sb = await getSupabaseAdmin();
  let query = sb
    .from('tickets')
    .select('id, case_category, product_id, created_at')
    .gte('created_at', startUtc)
    .lt('created_at', endUtc)
    .limit(5000);
  if (filter.active) query = query.in('product_id', Array.from(filter.childIds));
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const breakdown = emptyCategories();
  for (const row of data ?? []) {
    const category = (CASE_CATEGORIES as readonly string[]).includes(row.case_category)
      ? (row.case_category as CaseCategory)
      : 'unclassified';
    breakdown[category] += 1;
  }
  return { total: data?.length ?? 0, breakdown };
}

export async function readInquiryStatsCapability(sp: URLSearchParams) {
  const filter = await resolveProductFilter({
    product_id: sp.get('product_id'),
    product: sp.get('product'),
  });
  if (!filter.resolved_ok) {
    return { ok: false, product_filter: productFilterOutput(filter) };
  }
  const custom = resolveCustomRange(sp.get('date_from'), sp.get('date_to'));
  const range = custom ?? resolvePeriodRange('30d', null);
  const previousRange = previousPeriodRange(range);
  const [current, previous, defectData] = await Promise.all([
    countTickets(range, filter),
    countTickets(previousRange, filter),
    loadDefectRateData({
      period: 'custom',
      from: range.start,
      to: range.end,
      granularity: 'variation',
    }),
  ]);

  const defectRows = defectData.agg.variationRows.filter((row) => matchesProductFilter(filter, row));
  const majorBreakdown = emptyMajors();
  const fbaSymptoms: Record<string, number> = {};
  for (const row of defectRows) {
    for (const [label, count] of Object.entries(row.cause_breakdown)) {
      majorBreakdown[row.cause_majors[label] ?? 'other'] += count;
    }
    for (const detail of row.cases) {
      if (!detail.sources.includes('fba')) continue;
      for (const cause of detail.causes) {
        fbaSymptoms[cause.label] = (fbaSymptoms[cause.label] ?? 0) + detail.count;
      }
    }
  }
  const diff = current.total - previous.total;
  return {
    ok: true,
    period: { from: range.start, to: range.end },
    basis_date: jstTodayYmd(),
    product_filter: productFilterOutput(filter),
    total_inquiries: current.total,
    case_category_breakdown: current.breakdown,
    defect_major_category_breakdown: majorBreakdown,
    fba_symptom_breakdown: fbaSymptoms,
    previous_period: {
      from: previousRange.start,
      to: previousRange.end,
      total_inquiries: previous.total,
      case_category_breakdown: previous.breakdown,
    },
    change_vs_previous: {
      diff,
      pct: previous.total === 0 ? null : (diff / previous.total) * 100,
    },
    sales_ok: defectData.salesOk,
    returns_ok: defectData.returnsOk,
    ...(defectData.returnsError ? { returns_error: defectData.returnsError } : {}),
    returns_truncated: defectData.returnsTruncated,
  };
}
