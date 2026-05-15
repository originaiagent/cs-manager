'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, X, Pencil, Loader2 } from 'lucide-react';

interface Props {
  id: string;
  endpoint: string; // /api/improvement-suggestions/[id] or /api/product-proposals/[id]
  status: string;
  options: Array<{ value: string; label: string; variant: 'accept' | 'reject' | 'edit' | 'escalate' }>;
}

const VARIANT_CLS: Record<string, string> = {
  accept: 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100',
  reject: 'bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100',
  edit: 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100',
  escalate: 'bg-orange-50 text-orange-700 border-orange-300 hover:bg-orange-100',
};

const VARIANT_ICON = {
  accept: Check,
  reject: X,
  edit: Pencil,
  escalate: Pencil,
};

export default function ActionButtons({ id, endpoint, status, options }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function setStatus(next: string) {
    if (busy) return;
    setBusy(next);
    try {
      const res = await fetch(endpoint, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `update failed: ${res.status}`);
      }
      startTransition(() => router.refresh());
    } catch (e: any) {
      alert(e?.message ?? '更新に失敗しました');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((opt) => {
        const Icon = VARIANT_ICON[opt.variant];
        const isActive = status === opt.value;
        return (
          <button
            key={opt.value}
            onClick={() => setStatus(opt.value)}
            disabled={busy !== null || isActive}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
              VARIANT_CLS[opt.variant] ?? 'bg-gray-50 text-gray-700 border-gray-200'
            } ${isActive ? 'ring-2 ring-offset-1 ring-gray-300 cursor-default' : ''} ${
              busy !== null && busy !== opt.value ? 'opacity-50' : ''
            }`}
          >
            {busy === opt.value ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Icon size={12} />
            )}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
