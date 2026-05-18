import { unstable_noStore as noStore } from 'next/cache';
import Link from 'next/link';
import { FileText, BookText } from 'lucide-react';
import EmptyState from '@/components/ui/empty-state';
import StatusBadge from '@/components/ui/status-badge';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import { resolveProductsByIds } from '@/lib/product-resolver';
import { formatRelative } from '@/lib/format';
import ActionButtons from './_components/action-buttons';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;

interface SearchParams {
  type?: string; // manual / faq
  status?: string;
}

const TARGET_TYPE_LABEL: Record<string, string> = {
  manual: '説明書',
  faq: 'FAQ',
};

const TARGET_TYPE_ICON: Record<string, any> = {
  manual: BookText,
  faq: FileText,
};

export default async function ImprovementSuggestionsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  noStore();
  const sb = await getSupabaseAdmin();

  let q = sb.from('improvement_suggestions').select('*');
  if (searchParams.type && (searchParams.type === 'manual' || searchParams.type === 'faq')) {
    q = q.eq('target_type', searchParams.type);
  }
  if (searchParams.status) q = q.eq('status', searchParams.status);
  q = q.order('created_at', { ascending: false }).limit(200);

  const { data: rows } = await q;
  const productIds = Array.from(
    new Set((rows ?? []).map((r) => r.target_product_id).filter(Boolean) as string[]),
  );
  const products = await resolveProductsByIds(productIds);

  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <span className="text-xs text-gray-500 font-medium mr-1">対象</span>
        {[
          { v: '', label: 'すべて' },
          { v: 'manual', label: '説明書' },
          { v: 'faq', label: 'FAQ' },
        ].map((opt) => {
          const active = (searchParams.type ?? '') === opt.v;
          return (
            <Link
              key={opt.v}
              href={`/quality/improvement-suggestions${opt.v ? `?type=${opt.v}` : ''}`}
              scroll={false}
              className={`inline-flex items-center rounded-full border px-3 py-1.5 text-xs transition-colors ${
                active
                  ? 'bg-brand-500 text-white border-brand-500'
                  : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
              }`}
            >
              {opt.label}
            </Link>
          );
        })}
      </div>

      {(rows ?? []).length === 0 ? (
        <EmptyState title="改善提案はまだありません" description="不良データを基に origin-ai が提案を生成すると、ここに表示されます (Phase 3.x 最終段)" />
      ) : (
        <div className="space-y-3">
          {(rows ?? []).map((r: any) => {
            const TIcon = TARGET_TYPE_ICON[r.target_type] ?? FileText;
            const product = r.target_product_id ? products.get(r.target_product_id) : null;
            const summary = (r.source_data_summary ?? {}) as Record<string, any>;
            return (
              <div
                key={r.id}
                className="rounded-xl border border-gray-200 bg-white p-4"
              >
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] text-gray-700">
                      <TIcon size={11} />
                      {TARGET_TYPE_LABEL[r.target_type] ?? r.target_type}
                    </span>
                    <StatusBadge status={r.status} variant="suggestion" />
                    {product && (
                      <span className="inline-flex items-center rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[11px] text-violet-700">
                        {product.name}
                      </span>
                    )}
                    {r.current_content_ref && (
                      <span className="text-[10px] text-gray-400 font-mono">
                        {r.current_content_ref}
                      </span>
                    )}
                  </div>
                  <span className="text-[10px] text-gray-400 shrink-0">
                    {formatRelative(r.created_at)}
                  </span>
                </div>
                <p className="text-sm text-gray-900 font-medium mb-1.5">
                  {r.suggested_change}
                </p>
                {r.reasoning && (
                  <p className="text-xs text-gray-600 mb-3">{r.reasoning}</p>
                )}
                {Object.keys(summary).length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-3">
                    {Object.entries(summary)
                      .slice(0, 6)
                      .map(([k, v]) => (
                        <span
                          key={k}
                          className="inline-flex items-center rounded border border-gray-200 bg-gray-50 px-2 py-0.5 text-[10px] text-gray-600 font-mono"
                        >
                          {k}: {String(v)}
                        </span>
                      ))}
                  </div>
                )}
                <ActionButtons
                  id={r.id}
                  kind="improvement-suggestion"
                  status={r.status}
                  options={[
                    { value: 'accepted', label: '採用', variant: 'accept' },
                    { value: 'editing', label: '編集中', variant: 'edit' },
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
