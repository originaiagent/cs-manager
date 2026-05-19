'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

interface Props {
  page: number;
  pageSize: number;
  totalCount: number;
}

/**
 * シンプルな前へ/次へ pagination。
 * - URL の `page` だけを書き換える。他の検索条件 (product / recipient / order / date_*) は保持
 * - 1 ページしかない場合は両ボタン無効化
 */
export default function Pagination({ page, pageSize, totalCount }: Props) {
  const router = useRouter();
  const sp = useSearchParams();
  const [pending, startTransition] = useTransition();

  const totalPages = Math.max(Math.ceil(totalCount / pageSize), 1);
  const hasPrev = page > 1;
  const hasNext = page < totalPages;

  function go(nextPage: number) {
    const next = new URLSearchParams(sp.toString());
    if (nextPage <= 1) next.delete('page');
    else next.set('page', String(nextPage));
    const qs = next.toString();
    startTransition(() => {
      router.push(`/customer-records${qs ? `?${qs}` : ''}`);
    });
  }

  return (
    <div className="mt-4 flex items-center justify-between">
      <div className="text-xs text-gray-500 tabular-nums">
        {page} ページ目 / 全 {totalPages} ページ (合計 {totalCount} 件)
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => go(page - 1)}
          disabled={!hasPrev || pending}
          className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          <ChevronLeft size={12} />
          前へ
        </button>
        <button
          type="button"
          onClick={() => go(page + 1)}
          disabled={!hasNext || pending}
          className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          次へ
          <ChevronRight size={12} />
        </button>
      </div>
    </div>
  );
}
