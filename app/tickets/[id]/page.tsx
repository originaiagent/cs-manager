import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import PageHeader from '@/components/ui/page-header';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import { fetchProductById, type CoreProduct } from '@/lib/core-client';
import {
  CASE_CATEGORY_LABELS,
  STATUS_BADGE_CLASS,
  STATUS_LABELS,
  formatRelative,
} from '@/lib/format';
import CustomerInfo from './_components/customer-info';
import StatusControls from './_components/status-controls';
import MessageThread from './_components/message-thread';
import ReplyForm from './_components/reply-form';

export const dynamic = 'force-dynamic';

interface Params {
  id: string;
}

export default async function TicketDetailPage({ params }: { params: Params }) {
  const sb = getSupabaseAdmin();

  const { data: ticket } = await sb
    .from('tickets')
    .select(
      'id, channel_id, external_id, customer_name, customer_email, subject, status, product_id, case_category, defect_type, channel_meta, created_at, channels(display_name, code)',
    )
    .eq('id', params.id)
    .maybeSingle();

  if (!ticket) notFound();

  // 並列で残り三つを取得
  const [messagesRes, draftRes, productRes] = await Promise.all([
    sb
      .from('messages')
      .select('id, direction, body, sender_name, sent_at')
      .eq('ticket_id', ticket.id)
      .order('sent_at', { ascending: true }),
    sb
      .from('ticket_drafts')
      .select('id, body, source, created_at')
      .eq('ticket_id', ticket.id)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle(),
    ticket.product_id
      ? fetchProductById(ticket.product_id)
      : Promise.resolve({ ok: false as const, error: undefined }),
  ]);

  const messages = messagesRes.data ?? [];
  const latestDraft = draftRes.data ?? null;
  const product: CoreProduct | null = productRes.ok ? productRes.product ?? null : null;
  const productError =
    !ticket.product_id || productRes.ok ? null : productRes.error ?? '不明エラー';

  const status = ticket.status;
  const badgeCls =
    STATUS_BADGE_CLASS[status] ?? 'bg-gray-50 text-gray-600 border-gray-200';
  const caseLabel = ticket.case_category
    ? CASE_CATEGORY_LABELS[ticket.case_category] ?? ticket.case_category
    : null;
  const channelMeta = (ticket.channel_meta as Record<string, any>) ?? {};
  const orderNumber = channelMeta?.order_number ?? null;

  return (
    <div className="max-w-4xl">
      <Link
        href="/inbox"
        className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-900 mb-3"
      >
        <ChevronLeft size={14} /> 受信箱に戻る
      </Link>

      <PageHeader
        title={ticket.subject || '(件名なし)'}
        description={`${(ticket as any).channels?.display_name ?? ''} ・ 受信 ${formatRelative(ticket.created_at)}`}
        rightSlot={<StatusControls ticketId={ticket.id} currentStatus={status} />}
      />

      <div className="flex items-center gap-2 mb-4">
        <span
          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${badgeCls}`}
        >
          {STATUS_LABELS[status] ?? status}
        </span>
        {caseLabel && (
          <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[10px] text-gray-600">
            {caseLabel}
          </span>
        )}
        {ticket.defect_type && (
          <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] text-amber-700">
            defect: {ticket.defect_type}
          </span>
        )}
      </div>

      <div className="mb-6">
        <CustomerInfo
          customerName={ticket.customer_name}
          customerEmail={ticket.customer_email}
          orderNumber={orderNumber}
          productId={ticket.product_id}
          product={product}
          productError={productError}
        />
      </div>

      <h2 className="text-xs font-semibold text-gray-500 tracking-wider mb-2">
        メッセージスレッド ({messages.length})
      </h2>
      <div className="mb-6">
        <MessageThread messages={messages as any} />
      </div>

      <h2 className="text-xs font-semibold text-gray-500 tracking-wider mb-2">返信</h2>
      <ReplyForm
        ticketId={ticket.id}
        initialBody={latestDraft?.body ?? ''}
        initialSource={latestDraft?.source ?? null}
        productAvailable={!!product}
      />
    </div>
  );
}
