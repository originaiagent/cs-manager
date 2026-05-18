import { unstable_noStore as noStore } from 'next/cache';
import Link from 'next/link';
import { ChevronLeft, Plus } from 'lucide-react';
import PageHeader from '@/components/ui/page-header';
import EmptyState from '@/components/ui/empty-state';
import Breadcrumb from '@/components/ui/breadcrumb';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import { resolveProductsByIds } from '@/lib/product-resolver';
import ScopeTabs from './_components/scope-tabs';
import SearchBar, { type SearchMode } from './_components/search-bar';
import ArticleCard from './_components/article-card';
import ProductGridCard from './_components/product-grid-card';
import StoreGridCard from './_components/store-grid-card';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;

interface SearchParams {
  scope?: string;
  q?: string;
  ai?: string;
  store?: string;
  product?: string;
  product_id?: string;
  store_id?: string;
  status?: string;
  sort?: string;
}

type Mode = 'flat' | 'product-grid' | 'product-detail' | 'store-grid' | 'store-detail';

function resolveMode(sp: SearchParams): Mode {
  if (sp.scope === 'product') return sp.product_id ? 'product-detail' : 'product-grid';
  if (sp.scope === 'store') return sp.store_id ? 'store-detail' : 'store-grid';
  return 'flat';
}

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  noStore();
  const sb = await getSupabaseAdmin();
  const mode = resolveMode(searchParams);

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

  // チャネル名解決 (全モードで使うことがある)
  const { data: channelsRaw } = await sb
    .from('channels')
    .select('code, display_name')
    .order('display_name');
  const storeDisplayMap: Record<string, string> = {};
  for (const c of channelsRaw ?? []) storeDisplayMap[c.code] = c.display_name;
  const channels = channelsRaw ?? [];

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
        <ModeContent
          mode={mode}
          searchParams={searchParams}
          storeDisplayMap={storeDisplayMap}
          channels={channels}
        />
      </div>

      <p className="text-[11px] text-gray-400 mt-4">
        ※ AI検索トグルはガワ実装で内部はキーワード検索 (pg_trgm) にフォールバック。最終段で
        embedding ベクトル検索に切替予定。
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// モード別コンテンツ
// ---------------------------------------------------------------------------

async function ModeContent({
  mode,
  searchParams,
  storeDisplayMap,
  channels,
}: {
  mode: Mode;
  searchParams: SearchParams;
  storeDisplayMap: Record<string, string>;
  channels: Array<{ code: string; display_name: string }>;
}) {
  if (mode === 'product-grid') return <ProductGrid searchParams={searchParams} />;
  if (mode === 'product-detail')
    return (
      <ProductDetail
        productId={searchParams.product_id!}
        searchParams={searchParams}
        storeDisplayMap={storeDisplayMap}
      />
    );
  if (mode === 'store-grid')
    return <StoreGrid storeDisplayMap={storeDisplayMap} channels={channels} />;
  if (mode === 'store-detail')
    return (
      <StoreDetail
        storeCode={searchParams.store_id!}
        storeDisplayName={storeDisplayMap[searchParams.store_id!] ?? searchParams.store_id!}
        searchParams={searchParams}
        storeDisplayMap={storeDisplayMap}
      />
    );
  return <FlatList searchParams={searchParams} storeDisplayMap={storeDisplayMap} />;
}

// ---------------------------------------------------------------------------
// flat (現状: すべて / 会社共通)
// ---------------------------------------------------------------------------
async function FlatList({
  searchParams,
  storeDisplayMap,
}: {
  searchParams: SearchParams;
  storeDisplayMap: Record<string, string>;
}) {
  const sb = await getSupabaseAdmin();
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
  if (searchParams.q && searchParams.q.trim()) {
    const pat = `%${searchParams.q.trim()}%`;
    q = q.or(`title.ilike.${pat},question.ilike.${pat},answer.ilike.${pat}`);
  }
  q = q.order('updated_at', { ascending: false }).limit(200);
  const { data: articles } = await q;

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
    <div className="space-y-3">
      <SearchBar searchMode="content" />
      <ArticleList
        articles={articles ?? []}
        storeDisplayMap={storeDisplayMap}
        productNameMap={productNameMap}
        emptyHint={searchParams.q}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// product-grid
// ---------------------------------------------------------------------------
async function ProductGrid({ searchParams }: { searchParams: SearchParams }) {
  const sb = await getSupabaseAdmin();
  // storage_scope=product のすべての記事を取得 → product_id 単位で集約
  const { data: articles } = await sb
    .from('knowledge_articles')
    .select(
      'id, storage_product_id, tags, status, reference_count, updated_at',
    )
    .eq('storage_scope', 'product');

  type ProductAgg = {
    product_id: string;
    article_count: number;
    total_reference_count: number;
    latest_updated_at: string | null;
    tag_counts: Map<string, number>;
  };
  const aggMap = new Map<string, ProductAgg>();
  for (const a of articles ?? []) {
    if (!a.storage_product_id) continue;
    const agg = aggMap.get(a.storage_product_id) ?? {
      product_id: a.storage_product_id,
      article_count: 0,
      total_reference_count: 0,
      latest_updated_at: null,
      tag_counts: new Map<string, number>(),
    };
    agg.article_count += 1;
    agg.total_reference_count += a.reference_count ?? 0;
    if (!agg.latest_updated_at || a.updated_at > agg.latest_updated_at) {
      agg.latest_updated_at = a.updated_at;
    }
    for (const t of a.tags ?? []) {
      agg.tag_counts.set(t, (agg.tag_counts.get(t) ?? 0) + 1);
    }
    aggMap.set(a.storage_product_id, agg);
  }

  // Core から名寄せ
  const products = await resolveProductsByIds(Array.from(aggMap.keys()));

  // 検索フィルタ (商品名)
  const qStr = searchParams.q?.trim().toLowerCase() ?? '';
  let aggs = Array.from(aggMap.values());
  if (qStr) {
    aggs = aggs.filter((a) => {
      const p = products.get(a.product_id);
      const name = (p?.name ?? '').toLowerCase();
      const variation = (p?.variation ?? '').toLowerCase();
      return (
        name.includes(qStr) ||
        variation.includes(qStr) ||
        a.product_id.toLowerCase() === qStr
      );
    });
  }
  // ソート: 件数 desc → 製品名 asc
  aggs.sort((a, b) => {
    if (b.article_count !== a.article_count) return b.article_count - a.article_count;
    const an = products.get(a.product_id)?.name ?? a.product_id;
    const bn = products.get(b.product_id)?.name ?? b.product_id;
    return an.localeCompare(bn);
  });

  return (
    <>
      <Breadcrumb
        items={[{ label: 'ナレッジ', href: '/knowledge' }, { label: '商品別' }]}
      />
      <SearchBar searchMode="product-name" />

      {aggs.length === 0 ? (
        <EmptyState
          title="該当する商品がありません"
          description={
            qStr
              ? `"${searchParams.q}" に一致する商品 (ナレッジが紐付いているもの) は見つかりませんでした`
              : '商品別ナレッジがまだ作成されていません'
          }
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {aggs.map((a) => {
            const p = products.get(a.product_id);
            const topTags = Array.from(a.tag_counts.entries())
              .sort((x, y) => y[1] - x[1])
              .map(([t]) => t);
            return (
              <ProductGridCard
                key={a.product_id}
                productId={a.product_id}
                productName={p?.name ?? `id=${a.product_id}`}
                variation={p?.variation ?? null}
                resolved={!!p?.resolved}
                articleCount={a.article_count}
                totalReferenceCount={a.total_reference_count}
                latestUpdatedAt={a.latest_updated_at}
                topTags={topTags}
              />
            );
          })}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// product-detail
// ---------------------------------------------------------------------------
async function ProductDetail({
  productId,
  searchParams,
  storeDisplayMap,
}: {
  productId: string;
  searchParams: SearchParams;
  storeDisplayMap: Record<string, string>;
}) {
  const sb = await getSupabaseAdmin();
  let q = sb
    .from('knowledge_articles')
    .select(
      'id, title, question, answer, storage_scope, storage_store_id, storage_product_id, applies_to_stores, applies_to_products, tags, status, reference_count, updated_at',
    )
    .eq('storage_scope', 'product')
    .eq('storage_product_id', productId);
  if (searchParams.q && searchParams.q.trim()) {
    const pat = `%${searchParams.q.trim()}%`;
    q = q.or(`title.ilike.${pat},question.ilike.${pat},answer.ilike.${pat}`);
  }
  q = q.order('updated_at', { ascending: false }).limit(200);

  const [{ data: articles }, products] = await Promise.all([
    q,
    resolveProductsByIds([productId]),
  ]);
  const product = products.get(productId);
  const productName = product?.name ?? `id=${productId}`;

  // applies_to_products にも紐づく可能性があるが、ここでは storage_product_id 一致のみ表示
  const productNameMap: Record<string, string> = { [productId]: productName };
  for (const a of articles ?? []) {
    for (const pid of a.applies_to_products ?? []) {
      if (!productNameMap[pid]) productNameMap[pid] = pid;
    }
  }

  return (
    <>
      <Breadcrumb
        items={[
          { label: 'ナレッジ', href: '/knowledge' },
          { label: '商品別', href: '/knowledge?scope=product' },
          { label: productName },
        ]}
      />
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-medium text-gray-700">
          {productName} のナレッジ {(articles ?? []).length}件
          {product?.variation && (
            <span className="ml-2 text-xs text-gray-500">({product.variation})</span>
          )}
        </h2>
        <Link
          href="/knowledge?scope=product"
          className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-900"
        >
          <ChevronLeft size={12} /> 商品一覧に戻る
        </Link>
      </div>
      <SearchBar searchMode="content" />
      <ArticleList
        articles={articles ?? []}
        storeDisplayMap={storeDisplayMap}
        productNameMap={productNameMap}
        emptyHint={searchParams.q}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// store-grid
// ---------------------------------------------------------------------------
async function StoreGrid({
  storeDisplayMap,
  channels,
}: {
  storeDisplayMap: Record<string, string>;
  channels: Array<{ code: string; display_name: string }>;
}) {
  const sb = await getSupabaseAdmin();
  const { data: articles } = await sb
    .from('knowledge_articles')
    .select('id, storage_store_id, tags, reference_count, updated_at')
    .eq('storage_scope', 'store');

  type StoreAgg = {
    store_id: string;
    article_count: number;
    total_reference_count: number;
    latest_updated_at: string | null;
    tag_counts: Map<string, number>;
  };
  const aggMap = new Map<string, StoreAgg>();
  for (const a of articles ?? []) {
    if (!a.storage_store_id) continue;
    const agg = aggMap.get(a.storage_store_id) ?? {
      store_id: a.storage_store_id,
      article_count: 0,
      total_reference_count: 0,
      latest_updated_at: null,
      tag_counts: new Map<string, number>(),
    };
    agg.article_count += 1;
    agg.total_reference_count += a.reference_count ?? 0;
    if (!agg.latest_updated_at || a.updated_at > agg.latest_updated_at) {
      agg.latest_updated_at = a.updated_at;
    }
    for (const t of a.tags ?? []) {
      agg.tag_counts.set(t, (agg.tag_counts.get(t) ?? 0) + 1);
    }
    aggMap.set(a.storage_store_id, agg);
  }

  // チャネルマスタ全件 (記事ゼロでもカード表示)
  const cards = channels.map((c) => {
    const agg = aggMap.get(c.code);
    return {
      store_id: c.code,
      store_display_name: c.display_name,
      article_count: agg?.article_count ?? 0,
      total_reference_count: agg?.total_reference_count ?? 0,
      latest_updated_at: agg?.latest_updated_at ?? null,
      top_tags: agg
        ? Array.from(agg.tag_counts.entries())
            .sort((x, y) => y[1] - x[1])
            .map(([t]) => t)
        : [],
    };
  });
  // ソート: 件数 desc → display_name asc
  cards.sort((a, b) => {
    if (b.article_count !== a.article_count) return b.article_count - a.article_count;
    return a.store_display_name.localeCompare(b.store_display_name);
  });

  return (
    <>
      <Breadcrumb
        items={[{ label: 'ナレッジ', href: '/knowledge' }, { label: '店舗共通' }]}
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {cards.map((c) => (
          <StoreGridCard
            key={c.store_id}
            storeCode={c.store_id}
            storeDisplayName={c.store_display_name}
            articleCount={c.article_count}
            totalReferenceCount={c.total_reference_count}
            latestUpdatedAt={c.latest_updated_at}
            topTags={c.top_tags}
          />
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// store-detail
// ---------------------------------------------------------------------------
async function StoreDetail({
  storeCode,
  storeDisplayName,
  searchParams,
  storeDisplayMap,
}: {
  storeCode: string;
  storeDisplayName: string;
  searchParams: SearchParams;
  storeDisplayMap: Record<string, string>;
}) {
  const sb = await getSupabaseAdmin();
  let q = sb
    .from('knowledge_articles')
    .select(
      'id, title, question, answer, storage_scope, storage_store_id, storage_product_id, applies_to_stores, applies_to_products, tags, status, reference_count, updated_at',
    )
    .eq('storage_scope', 'store')
    .eq('storage_store_id', storeCode);
  if (searchParams.q && searchParams.q.trim()) {
    const pat = `%${searchParams.q.trim()}%`;
    q = q.or(`title.ilike.${pat},question.ilike.${pat},answer.ilike.${pat}`);
  }
  q = q.order('updated_at', { ascending: false }).limit(200);
  const { data: articles } = await q;

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
    <>
      <Breadcrumb
        items={[
          { label: 'ナレッジ', href: '/knowledge' },
          { label: '店舗共通', href: '/knowledge?scope=store' },
          { label: storeDisplayName },
        ]}
      />
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-medium text-gray-700">
          {storeDisplayName} のナレッジ {(articles ?? []).length}件
        </h2>
        <Link
          href="/knowledge?scope=store"
          className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-900"
        >
          <ChevronLeft size={12} /> 店舗一覧に戻る
        </Link>
      </div>
      <SearchBar searchMode="content" />
      <ArticleList
        articles={articles ?? []}
        storeDisplayMap={storeDisplayMap}
        productNameMap={productNameMap}
        emptyHint={searchParams.q}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// 共通: 記事カード一覧
// ---------------------------------------------------------------------------
function ArticleList({
  articles,
  storeDisplayMap,
  productNameMap,
  emptyHint,
}: {
  articles: any[];
  storeDisplayMap: Record<string, string>;
  productNameMap: Record<string, string>;
  emptyHint?: string;
}) {
  if (articles.length === 0) {
    return (
      <EmptyState
        title="該当するナレッジがありません"
        description={
          emptyHint
            ? `"${emptyHint}" に一致する記事は見つかりませんでした`
            : 'スコープを変更するか、新規作成してください'
        }
      />
    );
  }
  return (
    <div className="space-y-3">
      {articles.map((a) => (
        <ArticleCard
          key={a.id}
          article={a}
          storeDisplayMap={storeDisplayMap}
          productNameMap={productNameMap}
        />
      ))}
    </div>
  );
}
