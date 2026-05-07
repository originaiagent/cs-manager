'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

type Channel = { code: string; display_name: string };

interface Props {
  channels: Channel[];
  counts: {
    all: number;
    untouched: number;
    in_progress: number;
    done: number;
  };
}

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'all', label: 'すべて' },
  { value: 'untouched', label: '未対応' },
  { value: 'in_progress', label: '対応中' },
  { value: 'done', label: '対応済み' },
];

export default function FilterChips({ channels, counts }: Props) {
  const router = useRouter();
  const sp = useSearchParams();
  const [pending, startTransition] = useTransition();

  const currentStatus = sp.get('status') ?? 'all';
  const currentChannel = sp.get('channel') ?? 'all';

  function pushFilter(key: 'status' | 'channel', value: string) {
    const next = new URLSearchParams(sp.toString());
    if (value === 'all') next.delete(key);
    else next.set(key, value);
    startTransition(() => {
      router.push(`/inbox${next.toString() ? `?${next}` : ''}`);
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-gray-500 font-medium mr-1">状態</span>
        {STATUS_OPTIONS.map((opt) => {
          const active = currentStatus === opt.value;
          const count =
            opt.value === 'all'
              ? counts.all
              : opt.value === 'untouched'
                ? counts.untouched
                : opt.value === 'in_progress'
                  ? counts.in_progress
                  : counts.done;
          return (
            <button
              key={opt.value}
              onClick={() => pushFilter('status', opt.value)}
              disabled={pending}
              className={`
                inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs
                transition-colors
                ${
                  active
                    ? 'bg-brand-500 text-white border-brand-500'
                    : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
                }
              `}
            >
              <span>{opt.label}</span>
              <span
                className={`
                  inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-[10px] font-semibold
                  ${active ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-600'}
                `}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {channels.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-500 font-medium mr-1">チャネル</span>
          <button
            onClick={() => pushFilter('channel', 'all')}
            disabled={pending}
            className={`
              inline-flex items-center rounded-full border px-3 py-1.5 text-xs transition-colors
              ${
                currentChannel === 'all'
                  ? 'bg-gray-900 text-white border-gray-900'
                  : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
              }
            `}
          >
            すべて
          </button>
          {channels.map((c) => {
            const active = currentChannel === c.code;
            return (
              <button
                key={c.code}
                onClick={() => pushFilter('channel', c.code)}
                disabled={pending}
                className={`
                  inline-flex items-center rounded-full border px-3 py-1.5 text-xs transition-colors
                  ${
                    active
                      ? 'bg-gray-900 text-white border-gray-900'
                      : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
                  }
                `}
              >
                {c.display_name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
