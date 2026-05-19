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
  searchParams: Record<string, string | undefined>;
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
      ) : (
        <>
          <RecordsTableClient records={records} />
          <Pagination page={page} pageSize={pageSize} totalCount={totalCount} />
        </>
      )}
    </div>
  );
}
