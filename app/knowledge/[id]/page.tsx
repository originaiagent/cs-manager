import { unstable_noStore as noStore } from 'next/cache';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft, Pencil } from 'lucide-react';
import PageHeader from '@/components/ui/page-header';
import ScopeBadge from '@/components/ui/scope-badge';
import StatusBadge from '@/components/ui/status-badge';
import ChannelBadge from '@/components/ui/channel-badge';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import { resolveProductsByIds } from '@/lib/product-resolver';
import { CASE_CATEGORY_LABELS, DEFECT_TYPE_LABELS, formatDateTime } from '@/lib/format';
import ArchiveButton from './_components/archive-button';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;

export default async function KnowledgeDetail({
  params,
}: {
  params: { id: string };
}) {
  noStore();
  const sb = getSupabaseAdmin();
  const { data: a } = await sb
    .from('knowledge_articles')
    .select('*')
    .eq('id', params.id)
    .maybeSingle();
  if (!a) notFound();

  const { data: channelsRaw } = await sb
    .from('channels')
    .select('code, display_name');
  const storeDisplayMap: Record<string, string> = {};
  for (const c of channelsRaw ?? []) storeDisplayMap[c.code] = c.display_name;

  const productIds = new Set<string>();
  if (a.storage_product_id) productIds.add(a.storage_product_id);
  for (const pid of a.applies_to_products ?? []) productIds.add(pid);
  const products = await resolveProductsByIds(Array.from(productIds));

  return (
    <div className="max-w-3xl">
      <Link
        href="/knowledge"
        className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-900 mb-3"
      >
        <ChevronLeft size={14} /> ナレッジ一覧に戻る
      </Link>

      <PageHeader
        title={a.title}
        description={`更新 ${formatDateTime(a.updated_at)} ・ 参照 ${a.reference_count} 回`}
        rightSlot={
          <div className="flex items-center gap-2">
            <Link
              href={`/knowledge/${a.id}/edit`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
            >
              <Pencil size={14} /> 編集
            </Link>
            <ArchiveButton id={a.id} status={a.status} />
          </div>
        }
      />

      <div className="flex items-center gap-2 flex-wrap mb-5">
        <ScopeBadge
          scope={a.storage_scope}
          storeId={a.storage_store_id}
          storeDisplayName={
            a.storage_store_id ? storeDisplayMap[a.storage_store_id] : null
          }
          productId={a.storage_product_id}
          productName={
            a.storage_product_id ? products.get(a.storage_product_id)?.name : null
          }
        />
        <StatusBadge status={a.status} variant="knowledge" />
        {a.tags?.map((t: string) => (
          <span
            key={t}
            className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[10px] text-gray-600"
          >
            #{t}
          </span>
        ))}
      </div>

      <div className="space-y-5">
        {a.question && (
          <section>
            <p className="text-[11px] text-gray-400 font-medium tracking-wider mb-1">QUESTION</p>
            <p className="text-sm text-gray-800 whitespace-pre-wrap">{a.question}</p>
          </section>
        )}
        {a.answer && (
          <section>
            <p className="text-[11px] text-gray-400 font-medium tracking-wider mb-1">ANSWER</p>
            <p className="text-sm text-gray-800 whitespace-pre-wrap">{a.answer}</p>
          </section>
        )}
        {a.body_markdown && (
          <section>
            <p className="text-[11px] text-gray-400 font-medium tracking-wider mb-1">BODY (Markdown)</p>
            <pre className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-800 whitespace-pre-wrap font-mono">
              {a.body_markdown}
            </pre>
          </section>
        )}

        <section className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-[11px] text-gray-400 font-medium tracking-wider mb-3">
            APPLIES TO (適用範囲)
          </p>
          <div className="space-y-2 text-xs">
            {a.applies_to_stores?.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-gray-500 w-16">店舗:</span>
                {a.applies_to_stores.map((s: string) => (
                  <ChannelBadge key={s} code={s} displayName={storeDisplayMap[s] ?? s} />
                ))}
              </div>
            )}
            {a.applies_to_products?.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-gray-500 w-16">製品:</span>
                {a.applies_to_products.map((p: string) => (
                  <span
                    key={p}
                    className="inline-flex items-center rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] text-violet-700"
                  >
                    {products.get(p)?.name ?? `id=${p}`}
                  </span>
                ))}
              </div>
            )}
            {a.applies_to_categories?.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-gray-500 w-16">ケース:</span>
                {a.applies_to_categories.map((c: string) => (
                  <span
                    key={c}
                    className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[10px] text-gray-700"
                  >
                    {CASE_CATEGORY_LABELS[c] ?? c}
                  </span>
                ))}
              </div>
            )}
            {a.applies_to_defect_types?.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-gray-500 w-16">不良種別:</span>
                {a.applies_to_defect_types.map((d: string) => (
                  <span
                    key={d}
                    className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] text-amber-700"
                  >
                    {DEFECT_TYPE_LABELS[d] ?? d}
                  </span>
                ))}
              </div>
            )}
            {!a.applies_to_stores?.length &&
              !a.applies_to_products?.length &&
              !a.applies_to_categories?.length &&
              !a.applies_to_defect_types?.length && (
                <p className="text-gray-400">指定なし (全社共通として運用)</p>
              )}
          </div>
        </section>
      </div>
    </div>
  );
}
