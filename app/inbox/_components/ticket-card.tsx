import Link from 'next/link';
import {
  CASE_CATEGORY_LABELS,
  STATUS_BADGE_CLASS,
  STATUS_LABELS,
  formatRelative,
} from '@/lib/format';

interface Props {
  ticket: {
    id: string;
    subject: string | null;
    customer_name: string | null;
    status: string;
    case_category: string | null;
    created_at: string;
    channel: { display_name: string | null } | null;
    last_inbound_at: string | null;
  };
}

export default function TicketCard({ ticket }: Props) {
  const status = ticket.status;
  const badgeCls =
    STATUS_BADGE_CLASS[status] ?? 'bg-gray-50 text-gray-600 border-gray-200';
  const caseLabel = ticket.case_category
    ? CASE_CATEGORY_LABELS[ticket.case_category] ?? ticket.case_category
    : null;

  return (
    <Link
      href={`/tickets/${ticket.id}`}
      className="block rounded-xl border border-gray-200 bg-white p-4 hover:border-brand-500 hover:shadow-sm transition-all"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
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
            {ticket.channel?.display_name && (
              <span className="text-[10px] text-gray-400">
                {ticket.channel.display_name}
              </span>
            )}
          </div>
          <h3 className="text-sm font-medium text-gray-900 truncate">
            {ticket.subject || '(件名なし)'}
          </h3>
          <p className="text-xs text-gray-500 mt-1 truncate">
            {ticket.customer_name ?? '顧客名不明'}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[11px] text-gray-400">
            {formatRelative(ticket.last_inbound_at ?? ticket.created_at)}
          </p>
        </div>
      </div>
    </Link>
  );
}
