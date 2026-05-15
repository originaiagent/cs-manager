import { formatDateTime } from '@/lib/format';

interface Message {
  id: string;
  direction: 'inbound' | 'outbound' | string;
  body: string;
  sender_name: string | null;
  sent_at: string;
}

interface Props {
  messages: Message[];
}

export default function MessageThread({ messages }: Props) {
  if (messages.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-gray-300 bg-white p-10 text-center text-sm text-gray-500">
        メッセージはまだありません。
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {messages.map((m) => {
        const isOutbound = m.direction === 'outbound';
        return (
          <div
            key={m.id}
            className={`flex ${isOutbound ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`
                max-w-[88%] rounded-xl border px-4 py-3
                ${
                  isOutbound
                    ? 'bg-brand-50 border-brand-100 text-gray-800'
                    : 'bg-white border-gray-200 text-gray-800'
                }
              `}
            >
              <div className="flex items-center justify-between gap-3 mb-1">
                <span className="text-[11px] font-medium text-gray-700">
                  {isOutbound ? '🟦 自社' : '👤'} {m.sender_name ?? '不明'}
                </span>
                <span className="text-[10px] text-gray-400">
                  {formatDateTime(m.sent_at)}
                </span>
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{m.body}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
