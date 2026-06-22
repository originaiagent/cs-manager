import { unstable_noStore as noStore } from 'next/cache';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft, ClipboardList } from 'lucide-react';
import PageHeader from '@/components/ui/page-header';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import { fetchProductById, type CoreProduct } from '@/lib/core-client';
import {
  CASE_CATEGORY_LABELS,
  STATUS_BADGE_CLASS,
  STATUS_LABELS,
  formatRelative,
} from '@/lib/format';
import ChannelBadge from '@/components/ui/channel-badge';
import CustomerInfo from './_components/customer-info';
import StatusControls from './_components/status-controls';
import InquiryToRecordButton from './_components/inquiry-to-record-button';
import MessageThread from './_components/message-thread';
import ReplyForm from './_components/reply-form';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;

interface Params {
  id: string;
}

export default async function TicketDetailPage({ params }: { params: Params }) {
  noStore();
  const sb = await getSupabaseAdmin();

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
      .select('id, body, source, is_separated, created_at')
      .eq('ticket_id', ticket.id)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(1),
    ticket.product_id
      ? fetchProductById(ticket.product_id)
      : Promise.resolve({ ok: false as const, error: undefined }),
  ]);

  const messages = messagesRes.data ?? [];
  const latestDraft = (draftRes.data ?? [])[0] ?? null;

  // 送信安全ゲート (server-side, single source of truth)。
  // outbound (楽天) の送信可否規約と完全一致させる:
  //   送信安全 = source IN ('manual','first_response') OR is_separated === true
  //   - manual          : オペレータ入力 (生テキスト)
  //   - first_response   : テンプレ生成 (orchestrator、混在しない)。is_separated は付かない
  //   - is_separated=true: split-reply で分離した顧客向け本文のみ (ai_draft/rag)
  // 旧形式 = AI 由来 (ai_draft/rag) かつ未分離 (is_separated=false) は混在の可能性
  //   → initialBody は空にし legacyUnsafe を立てて再生成を促す。
  // ※ page と outbound で規約を一致させ「送信欄に出る = 送信可能」を保証する。
  //   first_response の手動レビュー (textarea 表示) を壊さない (codex review P2 反映)。
  const draftSource = (latestDraft?.source as string | null) ?? null;
  const draftIsSeparated = latestDraft?.is_separated === true;
  const isSendSafe =
    draftSource === 'manual' ||
    draftSource === 'first_response' ||
    draftIsSeparated;
  // legacyUnsafe = AI 由来かつ未分離 (= 送信不可、混在の可能性) のみ。
  const isLegacyUnsafe =
    !!latestDraft &&
    (draftSource === 'ai_draft' || draftSource === 'rag') &&
    !draftIsSeparated;
  const safeInitialBody = isSendSafe ? latestDraft?.body ?? '' : '';
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
        description={`受信 ${formatRelative(ticket.created_at)}`}
        rightSlot={
          <div className="flex items-center gap-2">
            <InquiryToRecordButton ticketId={ticket.id} />
            <Link
              href={`/customer-records/new?ticket_id=${encodeURIComponent(ticket.id)}${
                ticket.customer_name
                  ? `&recipient_name=${encodeURIComponent(ticket.customer_name)}`
                  : ''
              }${
                product?.product_name
                  ? `&product_name=${encodeURIComponent(product.product_name)}`
                  : ''
              }`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-700 hover:bg-gray-50"
            >
              <ClipboardList size={14} />
              対応記録に追加
            </Link>
            <StatusControls ticketId={ticket.id} currentStatus={status} />
          </div>
        }
      />

      <div className="flex items-center gap-2 mb-4 flex-wrap">
        {(ticket as any).channels?.code && (
          <ChannelBadge
            code={(ticket as any).channels.code}
            displayName={(ticket as any).channels.display_name}
            size="md"
          />
        )}
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
        initialBody={safeInitialBody}
        initialSource={draftSource}
        legacyUnsafe={isLegacyUnsafe}
        productAvailable={!!product}
      />
    </div>
  );
}
