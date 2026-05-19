'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Trash2, Loader2 } from 'lucide-react';
import { deleteArticle } from '../../_actions/delete-article';

interface Props {
  articleId: string;
  articleTitle?: string;
}

export default function DeleteButton({ articleId, articleTitle }: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    const msg = articleTitle
      ? `「${articleTitle}」を削除しますか? この操作は元に戻せません。`
      : 'このナレッジを削除しますか? この操作は元に戻せません。';
    if (!confirm(msg)) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await deleteArticle(articleId);
      if (!result.ok) {
        throw new Error(result.error ?? 'delete failed');
      }
      startTransition(() => router.push('/knowledge'));
      router.refresh();
    } catch (e: any) {
      setError(e?.message ?? 'unknown');
      setSubmitting(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleDelete}
        disabled={submitting}
        className="inline-flex items-center gap-2 rounded-lg border border-rose-200 bg-white px-3 py-2 text-sm text-rose-700 hover:bg-rose-50 disabled:opacity-50"
      >
        {submitting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
        削除
      </button>
      {error && (
        <p className="text-xs text-rose-600 mt-1">{error}</p>
      )}
    </div>
  );
}
