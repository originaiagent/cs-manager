'use client';

import { Search, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition, type FormEvent } from 'react';
import type { RecordSearchParams } from '../_lib/build-search-query';

interface Props {
  initial: RecordSearchParams;
}

/**
 * 対応記録一覧の検索フォーム。
 * - submit 時に URL params を構築し、router.push で同一ページに遷移 (page=1 にリセット)
 * - クリア時は全 params を消した状態で /customer-records に遷移
 * - 横並び 5 カラム grid (md 以上)、SP は縦並び
 */
export default function SearchForm({ initial }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [product, setProduct] = useState(initial.product ?? '');
  const [recipient, setRecipient] = useState(initial.recipient ?? '');
  const [order, setOrder] = useState(initial.order ?? '');
  const [dateFrom, setDateFrom] = useState(initial.date_from ?? '');
  const [dateTo, setDateTo] = useState(initial.date_to ?? '');

  // ブラウザバック/フォワード等で URL が変わり initial が更新された場合、
  // フォームの local state を同期させる。これがないと「URL ≠ フォーム表示」になり
  // 検索条件のリセット表示や直接遷移時のずれが発生する。
  useEffect(() => {
    setProduct(initial.product ?? '');
    setRecipient(initial.recipient ?? '');
    setOrder(initial.order ?? '');
    setDateFrom(initial.date_from ?? '');
    setDateTo(initial.date_to ?? '');
  }, [initial.product, initial.recipient, initial.order, initial.date_from, initial.date_to]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const next = new URLSearchParams();
    if (product.trim()) next.set('product', product.trim());
    if (recipient.trim()) next.set('recipient', recipient.trim());
    if (order.trim()) next.set('order', order.trim());
    if (dateFrom.trim()) next.set('date_from', dateFrom.trim());
    if (dateTo.trim()) next.set('date_to', dateTo.trim());
    // page は明示的に指定しない (page=1 = デフォルト)
    const qs = next.toString();
    startTransition(() => {
      router.push(`/customer-records${qs ? `?${qs}` : ''}`);
    });
  }

  function clear() {
    setProduct('');
    setRecipient('');
    setOrder('');
    setDateFrom('');
    setDateTo('');
    startTransition(() => {
      router.push('/customer-records');
    });
  }

  return (
    <form
      onSubmit={submit}
      className="mb-4 rounded-xl border border-gray-200 bg-white p-4"
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
        <div>
          <label className="block text-[11px] font-medium text-gray-500 mb-1">商品名</label>
          <input
            type="text"
            name="product"
            value={product}
            onChange={(e) => setProduct(e.target.value)}
            placeholder="部分一致"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-gray-500 mb-1">受取人</label>
          <input
            type="text"
            name="recipient"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="部分一致"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-gray-500 mb-1">注文番号</label>
          <input
            type="text"
            name="order"
            value={order}
            onChange={(e) => setOrder(e.target.value)}
            placeholder="部分一致"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-gray-500 mb-1">開始日</label>
          <input
            type="date"
            name="date_from"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-gray-500 mb-1">終了日</label>
          <input
            type="date"
            name="date_to"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
          />
        </div>
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={clear}
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
        >
          <X size={14} />
          クリア
        </button>
        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
        >
          <Search size={14} />
          検索
        </button>
      </div>
    </form>
  );
}
