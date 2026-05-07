'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

interface Counts {
  all: number;
  company: number;
  store: number;
  product: number;
}

const TABS: { value: 'all' | 'company' | 'store' | 'product'; label: string }[] = [
  { value: 'all', label: 'すべて' },
  { value: 'company', label: '会社共通' },
  { value: 'store', label: '店舗共通' },
  { value: 'product', label: '商品別' },
];

export default function ScopeTabs({ counts }: { counts: Counts }) {
  const router = useRouter();
  const sp = useSearchParams();
  const [pending, startTransition] = useTransition();
  const current = sp.get('scope') ?? 'all';

  function setScope(value: string) {
    const next = new URLSearchParams(sp.toString());
    if (value === 'all') next.delete('scope');
    else next.set('scope', value);
    // タブ切替時はドリルダウン位置と検索クエリをリセット
    next.delete('product_id');
    next.delete('store_id');
    next.delete('q');
    next.delete('ai');
    startTransition(() => {
      router.push(`/knowledge${next.toString() ? `?${next}` : ''}`);
    });
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {TABS.map((t) => {
        const active = current === t.value;
        const count =
          t.value === 'all'
            ? counts.all
            : t.value === 'company'
              ? counts.company
              : t.value === 'store'
                ? counts.store
                : counts.product;
        return (
          <button
            key={t.value}
            onClick={() => setScope(t.value)}
            disabled={pending}
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors ${
              active
                ? 'bg-brand-500 text-white border-brand-500'
                : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
            }`}
          >
            <span>{t.label}</span>
            <span
              className={`inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-[10px] font-semibold ${
                active ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-600'
              }`}
            >
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
