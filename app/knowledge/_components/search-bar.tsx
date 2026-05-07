'use client';

import { Search, Sparkles } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition, type FormEvent } from 'react';

export default function SearchBar() {
  const router = useRouter();
  const sp = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [q, setQ] = useState(sp.get('q') ?? '');
  const [aiOn, setAiOn] = useState(sp.get('ai') === '1');

  function submit(e: FormEvent) {
    e.preventDefault();
    const next = new URLSearchParams(sp.toString());
    if (q.trim()) next.set('q', q.trim());
    else next.delete('q');
    if (aiOn) next.set('ai', '1');
    else next.delete('ai');
    startTransition(() => {
      router.push(`/knowledge${next.toString() ? `?${next}` : ''}`);
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col sm:flex-row gap-2 items-stretch">
      <div className="flex-1 relative">
        <Search
          size={14}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
        />
        <input
          type="text"
          placeholder="ナレッジを検索 (タイトル / 質問 / 回答)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="w-full rounded-lg border border-gray-200 pl-9 pr-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
        />
      </div>
      <label
        className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium cursor-pointer transition-colors ${
          aiOn
            ? 'bg-violet-50 text-violet-700 border-violet-200'
            : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
        }`}
      >
        <input
          type="checkbox"
          checked={aiOn}
          onChange={(e) => setAiOn(e.target.checked)}
          className="sr-only"
        />
        <Sparkles size={12} />
        AI検索
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
      >
        検索
      </button>
    </form>
  );
}
