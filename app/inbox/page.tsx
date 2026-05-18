import { unstable_noStore as noStore } from 'next/cache';
import PageHeader from '@/components/ui/page-header';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import FilterChips from './_components/filter-chips';
import TicketCard from './_components/ticket-card';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;

interface SearchParams {
  status?: string;
  channel?: string;
  product?: string;
}

export default async function InboxPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  noStore();
  const sb = await getSupabaseAdmin();

  // チャネル一覧 (Phase 2.0: status 問わず全 channels をフィルタチップに表示)
  const { data: channelsRaw } = await sb
    .from('channels')
    .select('id, code, display_name, status')
    .order('display_name');
  const channels = channelsRaw ?? [];

  // ステータス別カウント (フィルタの bag に使う)
  const { data: countsRaw } = await sb
    .from('tickets')
    .select('status, channel_id', { count: 'exact', head: false });
  const counts = {
    all: countsRaw?.length ?? 0,
    untouched: countsRaw?.filter((r) => r.status === 'untouched').length ?? 0,
    in_progress: countsRaw?.filter((r) => r.status === 'in_progress').length ?? 0,
    done: countsRaw?.filter((r) => r.status === 'done').length ?? 0,
  };

  // tickets の取得 (フィルタ適用)
  let q = sb
    .from('tickets')
    .select(
      'id, subject, customer_name, status, case_category, created_at, channel_id, channels(code, display_name)',
    )
    .order('created_at', { ascending: false })
    .limit(200);

  if (searchParams.status && searchParams.status !== 'all') {
    q = q.eq('status', searchParams.status);
  }
  if (searchParams.channel && searchParams.channel !== 'all') {
    const ch = channels.find((c) => c.code === searchParams.channel);
    if (ch) q = q.eq('channel_id', ch.id);
  }
  if (searchParams.product) {
    q = q.eq('product_id', searchParams.product);
  }

  const { data: tickets } = await q;
  const ticketIds = (tickets ?? []).map((t) => t.id);

  // 各 ticket の最新 inbound メッセージ時刻を取得 (一覧表示用)
  let lastInboundMap = new Map<string, string>();
  if (ticketIds.length > 0) {
    const { data: msgs } = await sb
      .from('messages')
      .select('ticket_id, sent_at, direction')
      .in('ticket_id', ticketIds)
      .eq('direction', 'inbound')
      .order('sent_at', { ascending: false });
    for (const m of msgs ?? []) {
      if (!lastInboundMap.has(m.ticket_id)) {
        lastInboundMap.set(m.ticket_id, m.sent_at);
      }
    }
  }

  return (
    <div className="max-w-4xl">
      <PageHeader title="受信箱" description="チャネルから取り込んだ問い合わせを一覧表示します" />

      <FilterChips
        channels={channels.map((c) => ({ code: c.code, display_name: c.display_name }))}
        counts={counts}
      />

      <div className="mt-6 space-y-3">
        {(tickets ?? []).length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-300 bg-white p-10 text-center text-sm text-gray-500">
            該当するチケットがありません。
          </div>
        ) : (
          (tickets ?? []).map((t: any) => (
            <TicketCard
              key={t.id}
              ticket={{
                id: t.id,
                subject: t.subject,
                customer_name: t.customer_name,
                status: t.status,
                case_category: t.case_category,
                created_at: t.created_at,
                channel: t.channels
                  ? { code: t.channels.code, display_name: t.channels.display_name }
                  : null,
                last_inbound_at: lastInboundMap.get(t.id) ?? null,
              }}
            />
          ))
        )}
      </div>
    </div>
  );
}
