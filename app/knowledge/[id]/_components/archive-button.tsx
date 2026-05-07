'use client';

import { useTransition, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Archive, RotateCcw } from 'lucide-react';

export default function ArchiveButton({
  id,
  status,
}: {
  id: string;
  status: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  async function setStatus(next: string) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/knowledge/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) throw new Error('failed');
      startTransition(() => router.refresh());
    } catch {
      alert('更新に失敗しました');
    } finally {
      setBusy(false);
    }
  }

  if (status === 'archived') {
    return (
      <button
        onClick={() => setStatus('published')}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
      >
        <RotateCcw size={14} /> 復元
      </button>
    );
  }
  return (
    <button
      onClick={() => setStatus('archived')}
      disabled={busy}
      className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 hover:bg-rose-100 disabled:opacity-50"
    >
      <Archive size={14} /> アーカイブ
    </button>
  );
}
