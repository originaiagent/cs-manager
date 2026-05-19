import { unstable_noStore as noStore } from 'next/cache';
import Link from 'next/link';
import { ChevronLeft, Plus } from 'lucide-react';
import PageHeader from '@/components/ui/page-header';
import EmptyState from '@/components/ui/empty-state';
import Breadcrumb from '@/components/ui/breadcrumb';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import { resolveProductsByIds } from '@/lib/product-resolver';
import { listCoreProducts } from '@/lib/core-products-list';
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

function buildNewHref(sp: SearchParams): string {
  const params = new URLSearchParams();
  if (sp.scope === 'product' && sp.product_id) {
    params.set('scope', 'product');
    params.set('product_id', sp.product_id);
  } else if (sp.scope === 'store' && sp.store_id) {
    params.set('scope', 'store');
    params.set('store_id', sp.store_id);
  } else if (sp.scope === 'company') {
    params.set('scope', 'company');
  }
  const qs = params.toString();
  return qs ? `/knowledge/new?${qs}` : '/knowledge/new';
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
            href={buildNewHref(searchParams)}
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
  // 1) knowledge_articles 集約 (記事側)
  const { data: articles } = await sb
    .from('knowledge_articles')
    .select('id, storage_product_id, tags, status, reference_count, updated_at')
    .eq('storage_scope', 'product');

  type ProductAgg = {
    article_count: number;
    total_reference_count: number;
    latest_updated_at: string | null;
    tag_counts: Map<string, number>;
  };
  const aggMap = new Map<string, ProductAgg>();
  for (const a of articles ?? []) {
    if (!a.storage_product_id) continue;
    const agg = aggMap.get(a.storage_product_id) ?? {
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

  // 2) Core 商品マスタ全件
  const coreRes = await listCoreProducts({ fields: ['id', 'product_name', 'variation', 'group_name'] });

  // 3) Core 商品をベースに集約をleft join (記事0件の商品もカード表示)
  type Card = {
    product_id: string;
    product_name: string;
    variation: string | null;
    article_count: number;
    total_reference_count: number;
    latest_updated_at: string | null;
    top_tags: string[];
  };
  const cards: Card[] = (coreRes.items ?? []).map((p) => {
    const agg = aggMap.get(p.id);
    return {
      product_id: p.id,
      product_name: p.product_name,
      variation: p.variation,
      article_count: agg?.article_count ?? 0,
      total_reference_count: agg?.total_reference_count ?? 0,
      latest_updated_at: agg?.latest_updated_at ?? null,
      top_tags: agg
        ? Array.from(agg.tag_counts.entries()).sort((x, y) => y[1] - x[1]).map(([t]) => t)
        : [],
    };
  });

  // Core 一覧に含まれない (取得失敗 / 削除 / truncated) が、記事が紐付いている孤児 product_id は
  // 既存ナレッジへの導線を維持するため fallback row として追加 (product_name 解決不能なら id=... 表示)
  const coveredIds = new Set(cards.map((c) => c.product_id));
  const orphanIds = Array.from(aggMap.keys()).filter((id) => !coveredIds.has(id));
  if (orphanIds.length > 0) {
    const orphanResolved = await resolveProductsByIds(orphanIds);
    for (const id of orphanIds) {
      const agg = aggMap.get(id)!;
      const resolved = orphanResolved.get(id);
      cards.push({
        product_id: id,
        product_name: resolved?.name ?? `id=${id}`,
        variation: resolved?.variation ?? null,
        article_count: agg.article_count,
        total_reference_count: agg.total_reference_count,
        latest_updated_at: agg.latest_updated_at,
        top_tags: Array.from(agg.tag_counts.entries()).sort((x, y) => y[1] - x[1]).map(([t]) => t),
      });
    }
  }

  // 検索フィルタ (商品名 / variation)
  const qStr = searchParams.q?.trim().toLowerCase() ?? '';
  let filtered = cards;
  if (qStr) {
    filtered = cards.filter((c) =>
      c.product_name.toLowerCase().includes(qStr) ||
      (c.variation ?? '').toLowerCase().includes(qStr) ||
      c.product_id.toLowerCase() === qStr,
    );
  }
  // ソート: article_count desc → product_name asc (既存挙動)
  filtered.sort((a, b) => {
    if (b.article_count !== a.article_count) return b.article_count - a.article_count;
    return a.product_name.localeCompare(b.product_name);
  });

  return (
    <>
      <Breadcrumb items={[{ label: 'ナレッジ', href: '/knowledge' }, { label: '商品別' }]} />
      <SearchBar searchMode="product-name" />
      {!coreRes.ok && (
        <p className="text-xs text-rose-600 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 mb-3">
          Core 商品マスタから一覧を取得できませんでした: {coreRes.error}
        </p>
      )}
      {coreRes.truncated && (
        <p className="text-xs text-amber-700 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 mb-3">
          商品数が多いため先頭 5000 件のみ表示しています
        </p>
      )}
      {filtered.length === 0 ? (
        <EmptyState
          title="該当する商品がありません"
          description={qStr ? `"${searchParams.q}" に一致する商品は見つかりませんでした` : '商品マスタが空です'}
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {filtered.map((c) => (
            <ProductGridCard
              key={c.product_id}
              productId={c.product_id}
              productName={c.product_name}
              variation={c.variation}
              resolved={true}
              articleCount={c.article_count}
              totalReferenceCount={c.total_reference_count}
              latestUpdatedAt={c.latest_updated_at}
              topTags={c.top_tags}
            />
          ))}
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
        simplified
        titlePrefixToStrip={productName}
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
  simplified,
  titlePrefixToStrip,
}: {
  articles: any[];
  storeDisplayMap: Record<string, string>;
  productNameMap: Record<string, string>;
  emptyHint?: string;
  simplified?: boolean;
  titlePrefixToStrip?: string | null;
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
          simplified={simplified}
          titlePrefixToStrip={titlePrefixToStrip ?? null}
        />
      ))}
    </div>
  );
}
