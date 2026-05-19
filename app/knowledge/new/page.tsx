import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import PageHeader from '@/components/ui/page-header';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import { resolveProductsByIds } from '@/lib/product-resolver';
import ArticleForm from '../_components/article-form';

export const dynamic = 'force-dynamic';

interface SearchParams {
  scope?: string;
  product_id?: string;
  store_id?: string;
}

export default async function NewKnowledgePage({ searchParams }: { searchParams: SearchParams }) {
  const sb = await getSupabaseAdmin();
  const { data: channels } = await sb
    .from('channels')
    .select('code, display_name')
    .order('display_name');

  // scope 解決
  const scope: 'company' | 'store' | 'product' =
    searchParams.scope === 'product' ? 'product'
    : searchParams.scope === 'store' ? 'store'
    : 'company';
  const productId = scope === 'product' ? (searchParams.product_id ?? null) : null;
  const storeId = scope === 'store' ? (searchParams.store_id ?? null) : null;

  // 商品名解決 (商品別スコープ時のみ)
  let resolvedProductName: string | null = null;
  if (productId) {
    const m = await resolveProductsByIds([productId]);
    resolvedProductName = m.get(productId)?.name ?? null;
  }

  const initial = (scope === 'company' && !productId && !storeId)
    ? undefined
    : {
        storage_scope: scope,
        storage_product_id: productId,
        storage_store_id: storeId,
        resolved_product_name: resolvedProductName,
      };

  return (
    <div className="max-w-3xl">
      <Link
        href="/knowledge"
        className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-900 mb-3"
      >
        <ChevronLeft size={14} /> ナレッジ一覧に戻る
      </Link>
      <PageHeader title="ナレッジ新規作成" description="3階層スコープでナレッジ記事を新規作成します" />
      <ArticleForm channels={channels ?? []} mode="create" initial={initial as any} />
    </div>
  );
}
