'use client';

import { useEffect, useRef, useState } from 'react';
import { X, Search, Edit3, RotateCcw } from 'lucide-react';
import { suggestProducts } from '@/lib/actions/suggest-products';

export interface ProductPickerValue {
  id: number | null;       // Core product_id (手入力時は null)
  product_name: string;     // 必須 (DB product_name_text)
  variation: string | null; // DB variation_text
}

interface SuggestItem {
  id: string;
  product_name: string;
  variation?: string | null;
}

interface Props {
  value: ProductPickerValue;
  onChange: (v: ProductPickerValue) => void;
  label?: string;
  required?: boolean;
  allowManualInput?: boolean; // default true
}

function toIntId(s: string): number | null {
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export default function ProductPicker({
  value,
  onChange,
  label = '商品',
  required = false,
  allowManualInput = true,
}: Props) {
  // 初期モード判定: id=null かつ product_name あり → 手入力モード
  const initialManual = value.id == null && value.product_name.length > 0;
  const [manualMode, setManualMode] = useState(initialManual);

  // 検索モード state
  const [q, setQ] = useState('');
  const [items, setItems] = useState<SuggestItem[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    if (manualMode) return;
    if (!q.trim()) {
      // 検索中の in-flight レスポンスが古い結果でドロップダウンを再開しないよう seq を進める
      seqRef.current += 1;
      setItems([]);
      setLoading(false);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const mySeq = ++seqRef.current;
      setLoading(true);
      setError(null);
      try {
        const result = await suggestProducts(q.trim());
        if (mySeq !== seqRef.current) return;
        if (!result.ok) throw new Error(result.error ?? 'サジェスト取得失敗');
        setItems(result.items ?? []);
        setOpen(true);
      } catch (e: any) {
        if (mySeq !== seqRef.current) return;
        setError(e.message ?? 'failed');
        setItems([]);
      } finally {
        if (mySeq === seqRef.current) setLoading(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [q, manualMode]);

  function pick(item: SuggestItem) {
    const intId = toIntId(item.id);
    if (intId == null) {
      // 数値化失敗 → 手入力扱い (product_name のみ採用)
      onChange({ id: null, product_name: item.product_name, variation: item.variation ?? null });
      setManualMode(true);
    } else {
      onChange({ id: intId, product_name: item.product_name, variation: item.variation ?? null });
    }
    setQ('');
    setItems([]);
    setOpen(false);
  }

  function clearSelection() {
    onChange({ id: null, product_name: '', variation: null });
    setQ('');
    setItems([]);
  }

  function enterManual() {
    setManualMode(true);
    setQ('');
    setItems([]);
    setOpen(false);
  }

  function backToSearch() {
    setManualMode(false);
    onChange({ id: null, product_name: '', variation: null });
  }

  // ---- 手入力モード ----
  if (manualMode) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="block text-xs font-medium text-gray-600">
            {label} (手入力モード){required && <span className="text-rose-600 ml-1">*</span>}
          </label>
          <button
            type="button"
            onClick={backToSearch}
            className="inline-flex items-center gap-1 text-[11px] text-blue-600 hover:text-blue-800"
          >
            <RotateCcw size={11} /> Core 検索に戻る
          </button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <input
            type="text"
            value={value.product_name}
            onChange={(e) => onChange({ ...value, id: null, product_name: e.target.value })}
            placeholder="商品名 (必須)"
            required={required}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
          />
          <input
            type="text"
            value={value.variation ?? ''}
            onChange={(e) => onChange({ ...value, variation: e.target.value || null })}
            placeholder="バリエーション (任意)"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
          />
        </div>
        <p className="text-[10px] text-gray-400">
          Core 商品マスタに存在しない商品を入力する場合のみ使用してください
        </p>
      </div>
    );
  }

  // ---- 検索モード ----
  const hasSelection = value.id != null;

  return (
    <div className="space-y-2">
      <label className="block text-xs font-medium text-gray-600">
        {label}{required && <span className="text-rose-600 ml-1">*</span>}
      </label>
      {hasSelection ? (
        <div className="flex flex-wrap gap-1.5 items-center">
          <span className="inline-flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 text-xs text-violet-700">
            <span className="font-medium">{value.product_name}</span>
            {value.variation && <span className="text-violet-500 ml-1">/ {value.variation}</span>}
            <span className="text-violet-400 ml-1">id={value.id}</span>
            <button
              type="button"
              onClick={clearSelection}
              className="hover:text-violet-900"
              aria-label="選択解除"
            >
              <X size={12} />
            </button>
          </span>
        </div>
      ) : (
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onFocus={() => items.length > 0 && setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            placeholder="商品名で検索 (Core商品マスタ)"
            className="w-full rounded-lg border border-gray-200 pl-9 pr-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
          />
          {open && (items.length > 0 || loading || error) && (
            <div className="absolute top-full mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-md max-h-60 overflow-auto z-30">
              {loading && <p className="px-3 py-2 text-xs text-gray-500">検索中…</p>}
              {error && <p className="px-3 py-2 text-xs text-rose-600">サジェスト失敗: {error}</p>}
              {items.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  onMouseDown={() => pick(item)}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-gray-50 border-b border-gray-100 last:border-b-0"
                >
                  <span className="text-gray-900">{item.product_name}</span>
                  {item.variation && <span className="text-gray-500 ml-1">/ {item.variation}</span>}
                  <span className="text-gray-400 ml-2">id={item.id}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {allowManualInput && !hasSelection && (
        <button
          type="button"
          onClick={enterManual}
          className="inline-flex items-center gap-1 text-[11px] text-gray-600 hover:text-gray-900"
        >
          <Edit3 size={11} /> 該当なし: 手入力モードに切替
        </button>
      )}
    </div>
  );
}
