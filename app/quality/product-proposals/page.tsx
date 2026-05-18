import { unstable_noStore as noStore } from 'next/cache';
import { AlertTriangle } from 'lucide-react';
import EmptyState from '@/components/ui/empty-state';
import StatusBadge from '@/components/ui/status-badge';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import { resolveProductsByIds } from '@/lib/product-resolver';
import { formatPercent, formatRelative } from '@/lib/format';
import ActionButtons from '../improvement-suggestions/_components/action-buttons';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;

const CATEGORY_LABEL: Record<string, string> = {
  design: '設計',
  material: '素材',
  inspection: '検品',
  package: 'パッケージ',
  other: 'その他',
};

const CATEGORY_ORDER = ['design', 'material', 'inspection', 'package', 'other'];

export default async function ProductProposalsPage() {
  noStore();
  const sb = await getSupabaseAdmin();
  const { data: rows } = await sb
    .from('product_improvement_proposals')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200);

  const productIds = Array.from(
    new Set((rows ?? []).map((r) => r.product_id)),
  );
  const products = await resolveProductsByIds(productIds);

  return (
    <div>
      {(rows ?? []).length === 0 ? (
        <EmptyState
          title="製品改善提案はまだありません"
          description="閾値超過時に origin-ai が提案を生成すると、ここに表示されます (Phase 3.x 最終段)"
        />
      ) : (
        <div className="space-y-4">
          {(rows ?? []).map((r: any) => {
            const product = products.get(r.product_id);
            const overThreshold =
              r.defect_rate != null &&
              r.threshold_at_trigger != null &&
              r.defect_rate >= r.threshold_at_trigger;
            const breakdown = (r.defect_breakdown ?? {}) as Record<string, number>;
            const changes = (r.suggested_changes ?? {}) as Record<string, string>;
            return (
              <div
                key={r.id}
                className={`rounded-xl border ${
                  overThreshold ? 'border-rose-200 bg-rose-50/30' : 'border-gray-200 bg-white'
                } p-4`}
              >
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="inline-flex items-center rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[11px] text-violet-700">
                      {product?.name ?? `id=${r.product_id}`}
                      {product?.variation && (
                        <span className="ml-1 text-[10px] text-violet-500">
                          ({product.variation})
                        </span>
                      )}
                    </span>
                    <StatusBadge status={r.status} variant="proposal" />
                    {overThreshold && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-100 px-2 py-0.5 text-[10px] font-medium text-rose-700">
                        <AlertTriangle size={10} />
                        閾値超過
                      </span>
                    )}
                  </div>
                  <span className="text-[10px] text-gray-400 shrink-0">
                    {formatRelative(r.created_at)}
                  </span>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4 text-center">
                  <div className="rounded-lg bg-gray-50 px-3 py-2">
                    <p className="text-[10px] text-gray-500 uppercase tracking-wider">不良率</p>
                    <p
                      className={`text-base font-semibold tabular-nums ${
                        overThreshold ? 'text-rose-700' : 'text-gray-900'
                      }`}
                    >
                      {formatPercent(r.defect_rate, 1)}
                    </p>
                  </div>
                  <div className="rounded-lg bg-gray-50 px-3 py-2">
                    <p className="text-[10px] text-gray-500 uppercase tracking-wider">閾値</p>
                    <p className="text-base font-semibold tabular-nums text-gray-900">
                      {formatPercent(r.threshold_at_trigger, 1)}
                    </p>
                  </div>
                  <div className="rounded-lg bg-gray-50 px-3 py-2">
                    <p className="text-[10px] text-gray-500 uppercase tracking-wider">不良内訳</p>
                    <p className="text-xs text-gray-800 mt-1">
                      {Object.entries(breakdown)
                        .filter(([, v]) => Number(v) > 0)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(' / ') || '-'}
                    </p>
                  </div>
                  <div className="rounded-lg bg-gray-50 px-3 py-2">
                    <p className="text-[10px] text-gray-500 uppercase tracking-wider">参照Ticket</p>
                    <p className="text-base font-semibold tabular-nums text-gray-900">
                      {r.source_ticket_ids?.length ?? 0}
                    </p>
                  </div>
                </div>

                {Object.keys(changes).length > 0 && (
                  <div className="space-y-2 mb-4">
                    <p className="text-[11px] text-gray-500 font-medium tracking-wider">
                      改善カテゴリ別 提案
                    </p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                      {CATEGORY_ORDER.filter((c) => changes[c]).map((c) => (
                        <div
                          key={c}
                          className="rounded-lg border border-gray-200 bg-white px-3 py-2"
                        >
                          <p className="text-[10px] text-gray-500 uppercase tracking-wider">
                            {CATEGORY_LABEL[c] ?? c}
                          </p>
                          <p className="text-xs text-gray-800 mt-0.5">{changes[c]}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {r.reasoning && (
                  <p className="text-xs text-gray-600 mb-3 rounded-lg bg-gray-50 px-3 py-2">
                    <span className="font-medium text-gray-700">理由:</span> {r.reasoning}
                  </p>
                )}

                <ActionButtons
                  id={r.id}
                  kind="product-proposal"
                  status={r.status}
                  options={[
                    { value: 'accepted', label: '採用', variant: 'accept' },
                    { value: 'in_review', label: 'レビュー中', variant: 'edit' },
                    { value: 'escalated', label: 'エスカレ', variant: 'escalate' },
                    { value: 'rejected', label: '却下', variant: 'reject' },
                  ]}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
