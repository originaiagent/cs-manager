'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { STATUS_LABELS } from '@/lib/format';
import { updateTicketStatus } from '../_actions/update-status';

interface Props {
  ticketId: string;
  currentStatus: string;
}

const STATUSES: { value: string; label: string }[] = [
  { value: 'untouched', label: STATUS_LABELS.untouched },
  { value: 'in_progress', label: STATUS_LABELS.in_progress },
  { value: 'done', label: STATUS_LABELS.done },
];

export default function StatusControls({ ticketId, currentStatus }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [updating, setUpdating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleClick(next: string) {
    if (next === currentStatus || pending) return;
    setUpdating(next);
    setError(null);
    try {
      const result = await updateTicketStatus(
        ticketId,
        next as 'untouched' | 'in_progress' | 'done',
      );
      if (!result.ok) throw new Error(result.error ?? 'update failed');
      startTransition(() => router.refresh());
    } catch (e: any) {
      setError(e?.message ?? 'unknown error');
    } finally {
      setUpdating(null);
    }
  }

  return (
    <div>
      <div className="inline-flex rounded-lg border border-gray-200 bg-white p-1">
        {STATUSES.map((s) => {
          const active = currentStatus === s.value;
          const isUpdating = updating === s.value;
          return (
            <button
              key={s.value}
              onClick={() => handleClick(s.value)}
              disabled={pending || updating !== null}
              className={`
                px-3 py-1.5 rounded-md text-xs font-medium transition-colors
                ${active ? 'bg-brand-500 text-white' : 'text-gray-600 hover:bg-gray-50'}
                ${pending || updating !== null ? 'opacity-60 cursor-not-allowed' : ''}
              `}
            >
              {isUpdating ? '更新中…' : s.label}
            </button>
          );
        })}
      </div>
      {error && (
        <p className="text-xs text-rose-600 mt-1">ステータス更新失敗: {error}</p>
      )}
    </div>
  );
}
