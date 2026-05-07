'use client';

import { useState, useEffect, useRef } from 'react';
import { X, Search } from 'lucide-react';

interface SuggestItem {
  id: string;
  product_name: string;
  variation?: string | null;
}

interface Props {
  selected: string[];  // product ids
  onChange: (ids: string[]) => void;
  label?: string;
}

export default function ProductSuggest({ selected, onChange, label = '製品 (Core)' }: Props) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<SuggestItem[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolvedNames, setResolvedNames] = useState<Record<string, string>>({});
  const debounceRef = useRef<any>(null);

  useEffect(() => {
    if (!q.trim()) {
      setItems([]);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/products/suggest?q=${encodeURIComponent(q.trim())}`,
        );
        const j = await res.json();
        if (!j.ok) throw new Error(j.error ?? 'サジェスト取得失敗');
        setItems(j.items ?? []);
        setOpen(true);
      } catch (e: any) {
        setError(e.message ?? 'failed');
        setItems([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => debounceRef.current && clearTimeout(debounceRef.current);
  }, [q]);

  function pick(item: SuggestItem) {
    if (selected.includes(item.id)) return;
    onChange([...selected, item.id]);
    setResolvedNames((prev) => ({ ...prev, [item.id]: item.product_name }));
    setQ('');
    setItems([]);
    setOpen(false);
  }

  function remove(id: string) {
    onChange(selected.filter((x) => x !== id));
  }

  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1.5">{label}</label>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {selected.map((id) => (
          <span
            key={id}
            className="inline-flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[11px] text-violet-700"
          >
            {resolvedNames[id] ?? `id=${id}`}
            <button
              type="button"
              onClick={() => remove(id)}
              className="hover:text-violet-900"
            >
              <X size={11} />
            </button>
          </span>
        ))}
      </div>
      <div className="relative">
        <Search
          size={14}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
        />
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => items.length > 0 && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="製品名で検索 (例: クール)"
          className="w-full rounded-lg border border-gray-200 pl-9 pr-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
        />
        {open && (items.length > 0 || loading || error) && (
          <div className="absolute top-full mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-md max-h-60 overflow-auto z-30">
            {loading && (
              <p className="px-3 py-2 text-xs text-gray-500">検索中…</p>
            )}
            {error && (
              <p className="px-3 py-2 text-xs text-rose-600">サジェスト失敗: {error}</p>
            )}
            {items.map((item) => (
              <button
                type="button"
                key={item.id}
                onMouseDown={() => pick(item)}
                className="w-full text-left px-3 py-2 text-xs hover:bg-gray-50 border-b border-gray-100 last:border-b-0"
              >
                <span className="text-gray-900">{item.product_name}</span>
                {item.variation && (
                  <span className="text-gray-500 ml-1">/ {item.variation}</span>
                )}
                <span className="text-gray-400 ml-2">id={item.id}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="text-[10px] text-gray-400 mt-1">
        Core 製品マスタから検索。サジェスト失敗時は ID を直接入力してください。
      </p>
    </div>
  );
}
