import { unstable_noStore as noStore } from 'next/cache';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import PageHeader from '@/components/ui/page-header';
import EmptyState from '@/components/ui/empty-state';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import RecordsTableClient, { type CustomerRecord } from './_components/records-table-client';
import SearchForm from './_components/search-form';
import Pagination from './_components/pagination';
import {
  applySearchFilters,
  parsePagination,
  parseSearchParams,
} from './_lib/build-search-query';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;

export default async function CustomerRecordsListPage({
  searchParams,
}: {
  // Next.js App Router の searchParams は string | string[] | undefined を返すため
  // 配列形式 (?key=a&key=b) も型として受け入れる。helper 側で先頭値を採用。
  searchParams: Record<string, string | string[] | undefined>;
}) {
  noStore();
  const sb = await getSupabaseAdmin();
  const search = parseSearchParams(searchParams);
  const { page, pageSize } = parsePagination(searchParams);

  let q = sb
    .from('customer_service_records')
    .select('*', { count: 'exact' })
    .order('record_date', { ascending: false })
    .order('created_at', { ascending: false });

  q = applySearchFilters(q, search);

  const offset = (page - 1) * pageSize;
  q = q.range(offset, offset + pageSize - 1);

  const { data: rows, count } = await q;
  const records = (rows ?? []) as CustomerRecord[];
  const totalCount = count ?? 0;

  const hasSearch =
    !!(search.product || search.recipient || search.order || search.date_from || search.date_to);
  // page が範囲外 (page > totalPages) で records が空のとき、空テーブルだけ表示する
  // と何が起きたか分からないため、明示的に「ページ範囲外」状態として扱い 1 ページ目への
  // 案内を出す。totalCount === 0 の純粋な空とは別の文言にする。
  const totalPages = totalCount > 0 ? Math.ceil(totalCount / pageSize) : 0;
  const isOutOfRange = totalCount > 0 && page > totalPages;

  return (
    <div className="max-w-6xl">
      <PageHeader
        title="対応記録一覧"
        description="顧客対応の履歴 (再送・返金・返信等) を 1 件 1 行で管理"
        rightSlot={
          <Link
            href="/customer-records/new"
            className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600"
          >
            <Plus size={14} />
            新規登録
          </Link>
        }
      />

      <SearchForm initial={search} />

      {totalCount === 0 ? (
        <EmptyState
          title={hasSearch ? '該当する対応記録はありません' : '対応記録はまだありません'}
          description={
            hasSearch
              ? '検索条件を変更するか、クリアして全件を表示してください'
              : '右上の「新規登録」から最初の記録を作成してください'
          }
        />
      ) : isOutOfRange ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
          <p className="font-medium">指定ページは範囲外です</p>
          <p className="mt-1 text-xs">
            合計 {totalCount} 件 / 全 {totalPages} ページ。
            <Link
              href={`/customer-records?${new URLSearchParams({
                ...(search.product ? { product: search.product } : {}),
                ...(search.recipient ? { recipient: search.recipient } : {}),
                ...(search.order ? { order: search.order } : {}),
                ...(search.date_from ? { date_from: search.date_from } : {}),
                ...(search.date_to ? { date_to: search.date_to } : {}),
                page: '1',
                page_size: String(pageSize),
              }).toString()}`}
              className="ml-2 text-brand-700 underline hover:text-brand-800"
            >
              1 ページ目に戻る
            </Link>
          </p>
        </div>
      ) : (
        <>
          <RecordsTableClient records={records} />
          <Pagination page={page} pageSize={pageSize} totalCount={totalCount} />
        </>
      )}
    </div>
  );
}
