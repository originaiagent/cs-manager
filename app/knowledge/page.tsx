import { unstable_noStore as noStore } from 'next/cache';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import PageHeader from '@/components/ui/page-header';
import EmptyState from '@/components/ui/empty-state';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import { resolveProductsByIds } from '@/lib/product-resolver';
import ScopeTabs from './_components/scope-tabs';
import SearchBar from './_components/search-bar';
import ArticleCard from './_components/article-card';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;

interface SearchParams {
  scope?: string;
  q?: string;
  ai?: string;
  store?: string;
  product?: string;
  status?: string;
  sort?: string;
}

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  noStore();
  const sb = getSupabaseAdmin();

  // 全件カウント (タブ件数バッジ用)
  const { data: allRaw } = await sb
    .from('knowledge_articles')
    .select('id, storage_scope', { count: 'exact', head: false });
  const counts = {
    all: allRaw?.length ?? 0,
    company: allRaw?.filter((r) => r.storage_scope === 'company').length ?? 0,
    store: allRaw?.filter((r) => r.storage_scope === 'store').length ?? 0,
    product: allRaw?.filter((r) => r.storage_scope === 'product').length ?? 0,
  };

  // フィルタ + 検索
  let q = sb
    .from('knowledge_articles')
    .select(
      'id, title, question, answer, storage_scope, storage_store_id, storage_product_id, applies_to_stores, applies_to_products, tags, status, reference_count, updated_at',
    );

  if (searchParams.scope && searchParams.scope !== 'all') {
    q = q.eq('storage_scope', searchParams.scope);
  }
  if (searchParams.status && searchParams.status !== 'all') {
    q = q.eq('status', searchParams.status);
  }
  if (searchParams.store) {
    q = q.contains('applies_to_stores', [searchParams.store]);
  }
  if (searchParams.product) {
    q = q.contains('applies_to_products', [searchParams.product]);
  }
  if (searchParams.q && searchParams.q.trim()) {
    const pat = `%${searchParams.q.trim()}%`;
    // pg_trgm を活かした ilike (タイトル/質問/回答で OR)
    q = q.or(`title.ilike.${pat},question.ilike.${pat},answer.ilike.${pat}`);
  }

  const sort = searchParams.sort ?? 'relevance';
  if (sort === 'updated') {
    q = q.order('updated_at', { ascending: false });
  } else if (sort === 'reference_count') {
    q = q.order('reference_count', { ascending: false }).order('updated_at', { ascending: false });
  } else {
    // relevance: published > updated_at desc (簡易)
    q = q.order('status', { ascending: true }).order('reference_count', { ascending: false });
  }

  q = q.limit(200);
  const { data: articles } = await q;

  // チャネル名解決
  const { data: channelsRaw } = await sb
    .from('channels')
    .select('code, display_name');
  const storeDisplayMap: Record<string, string> = {};
  for (const c of channelsRaw ?? [])
    storeDisplayMap[c.code] = c.display_name;

  // 製品名解決 (storage_product_id + applies_to_products)
  const productIds = new Set<string>();
  for (const a of articles ?? []) {
    if (a.storage_product_id) productIds.add(a.storage_product_id);
    for (const pid of a.applies_to_products ?? []) productIds.add(pid);
  }
  const products = await resolveProductsByIds(Array.from(productIds));
  const productNameMap: Record<string, string> = {};
  Array.from(products.entries()).forEach(([id, p]) => {
    productNameMap[id] = p.name;
  });

  return (
    <div className="max-w-5xl">
      <PageHeader
        title="ナレッジ"
        description="会社共通・店舗共通・商品別の3階層で運用するCSナレッジベース"
        rightSlot={
          <Link
            href="/knowledge/new"
            className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600"
          >
            <Plus size={14} />
            新規作成
          </Link>
        }
      />

      <div className="space-y-3 mb-5">
        <ScopeTabs counts={counts} />
        <SearchBar />
      </div>

      <div className="space-y-3">
        {(articles ?? []).length === 0 ? (
          <EmptyState
            title="該当するナレッジがありません"
            description={
              searchParams.q
                ? `"${searchParams.q}" に一致する記事は見つかりませんでした`
                : 'スコープを変更するか、新規作成してください'
            }
          />
        ) : (
          (articles ?? []).map((a: any) => (
            <ArticleCard
              key={a.id}
              article={a}
              storeDisplayMap={storeDisplayMap}
              productNameMap={productNameMap}
            />
          ))
        )}
      </div>

      <p className="text-[11px] text-gray-400 mt-4">
        ※ AI検索トグルはガワ実装で内部はキーワード検索 (pg_trgm) にフォールバック。最終段で
        embedding ベクトル検索に切替予定。
      </p>
    </div>
  );
}
