import { unstable_noStore as noStore } from 'next/cache';
import Link from 'next/link';
import { Plus, Edit3, Hash } from 'lucide-react';
import PageHeader from '@/components/ui/page-header';
import EmptyState from '@/components/ui/empty-state';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;

const ACTION_LABEL: Record<string, string> = {
  reply_only: '返信のみ',
  reship_defect: '不良で再送',
  refund_defect: '不良で返金',
  reship_customer: '客都合で再送',
  addon_send: '追加発送',
  relation_send: '関係性発送',
};

export default async function CustomerRecordsListPage() {
  noStore();
  const sb = await getSupabaseAdmin();
  const { data: rows } = await sb
    .from('customer_service_records')
    .select(
      'id, product_id, product_name_text, variation_text, variation_id, variation_jan, recipient_name, recipient_honorific, action_type, defect_type, record_date, memo, ticket_id, created_at',
    )
    .order('record_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(200);

  const records = rows ?? [];

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

      {records.length === 0 ? (
        <EmptyState
          title="対応記録はまだありません"
          description="右上の「新規登録」から最初の記録を作成してください"
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium">日付</th>
                <th className="text-left px-4 py-2.5 font-medium">商品</th>
                <th className="text-left px-4 py-2.5 font-medium">受取人</th>
                <th className="text-left px-4 py-2.5 font-medium">対応種別</th>
                <th className="text-left px-4 py-2.5 font-medium">不良内容</th>
                <th className="text-left px-4 py-2.5 font-medium">メモ</th>
                <th className="text-left px-4 py-2.5 font-medium">関連</th>
                <th className="text-right px-4 py-2.5 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r: any) => (
                <tr key={r.id} className="border-t border-gray-100">
                  <td className="px-4 py-3 tabular-nums text-gray-700 whitespace-nowrap">
                    {r.record_date}
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900">{r.product_name_text}</div>
                    {r.variation_text && (
                      <div className="text-[11px] text-gray-500 mt-0.5">{r.variation_text}</div>
                    )}
                    {r.variation_jan && (
                      <div className="text-[10px] text-gray-400 mt-0.5">JAN: {r.variation_jan}</div>
                    )}
                    {(r.product_id != null || r.variation_id != null) && (
                      <div className="text-[10px] text-gray-400 mt-0.5 inline-flex items-center gap-1">
                        <Hash size={10} />
                        {r.product_id != null && <span>group={r.product_id}</span>}
                        {r.variation_id != null && (
                          <span>/variation={r.variation_id}</span>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-700">
                    {r.recipient_name}
                    {r.recipient_honorific && (
                      <span className="text-gray-400 text-xs ml-0.5">{r.recipient_honorific}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-700 whitespace-nowrap">
                    <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px]">
                      {ACTION_LABEL[r.action_type] ?? r.action_type}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-700">
                    {r.defect_type ? (
                      <span className="text-rose-700 text-xs">{r.defect_type}</span>
                    ) : (
                      <span className="text-gray-300">-</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-600 text-xs max-w-[260px]">
                    <div className="truncate" title={r.memo ?? ''}>
                      {r.memo ?? '-'}
                    </div>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    {r.ticket_id ? (
                      <Link
                        href={`/tickets/${r.ticket_id}`}
                        className="text-xs text-brand-700 hover:underline"
                      >
                        チケット
                      </Link>
                    ) : (
                      <span className="text-gray-300 text-xs">-</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <Link
                      href={`/customer-records/${r.id}`}
                      className="inline-flex items-center gap-1 text-xs text-brand-700 hover:underline"
                    >
                      <Edit3 size={12} />
                      編集
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
