'use client';

import { useEffect, useRef, useState } from 'react';
import { X, Search, Edit3, RotateCcw } from 'lucide-react';
import { suggestProducts } from '@/lib/actions/suggest-products';
import { fetchVariations } from '@/app/customer-records/_actions/fetch-variations';

/**
 * 親 + 子バリエーション選択用 Picker (PR-EF: Core 親子構造に厳密準拠)。
 *
 * I/F:
 *   parent_group_id: 親 product_groups.id (Core)
 *   variation_id:    子 products.id (Core) - record context のみ
 *   variation_name:  表示用商品名 (record では子 product_name、knowledge では親 group_name)
 *   variation_jan:   子バリエーション JAN スナップショット
 *
 * 動作:
 *   - 通常モード (search): 親グループ検索 → 親選択 → (record context のみ) 子取得
 *     - 子 0 件: variation_id=null のまま (親のみ保存可)
 *     - 子 1 件: 自動選択
 *     - 子 2 件以上: プルダウン
 *   - 手入力モード (manual): allowManualInput=true 時のみトグル可
 */

export interface ProductPickerValue {
  parent_group_id: number | null;
  parent_group_name: string;
  variation_id: number | null;
  variation_name: string;          // 表示用: product_name + (variation あれば付加)
  variation_text: string | null;   // Core products.variation 単体 (defect-rate 分析用)
  variation_jan: string | null;
}

interface SuggestGroupItem {
  id: string;
  group_name: string;
  developer?: string | null;
}

interface VariationItem {
  id: string;
  product_name: string;
  variation: string | null;
  jan_code: string | null;
}

interface Props {
  value: ProductPickerValue;
  onChange: (v: ProductPickerValue) => void;
  context: 'knowledge' | 'record';  // knowledge: 親のみ / record: 親+子バリエーション
  label?: string;
  required?: boolean;
  allowManualInput?: boolean;
}

function toIntId(s: string): number | null {
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function formatVariationName(p: { product_name: string; variation: string | null }): string {
  if (!p.variation) return p.product_name;
  return `${p.product_name} / ${p.variation}`;
}

export default function ProductPicker({
  value,
  onChange,
  context,
  label = '商品',
  required = false,
  allowManualInput = true,
}: Props) {
  // 初期モード判定:
  //   parent_group_id == null かつ variation_name あり → 手入力モード (旧データ含む)
  //   parent_group_id あり → 検索モード(選択済み表示)
  const initialManual = value.parent_group_id == null && value.variation_name.length > 0;
  const [manualMode, setManualMode] = useState(initialManual);

  // 検索モード state
  const [q, setQ] = useState('');
  const [items, setItems] = useState<SuggestGroupItem[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);

  // 子バリエーション state
  const [variations, setVariations] = useState<VariationItem[]>([]);
  const [loadingVariations, setLoadingVariations] = useState(false);
  const [variationError, setVariationError] = useState<string | null>(null);
  const variationSeqRef = useRef(0);

  // 検索 debounce
  useEffect(() => {
    if (manualMode) return;
    if (!q.trim()) {
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
        setItems((result.items ?? []) as SuggestGroupItem[]);
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

  // 親選択後の子バリエーション取得 (record context のみ)
  useEffect(() => {
    if (manualMode) {
      // モード切替時に in-flight な variation fetch を破棄
      variationSeqRef.current += 1;
      setVariations([]);
      setLoadingVariations(false);
      return;
    }
    if (context !== 'record') return;
    const gid = value.parent_group_id;
    if (gid == null) {
      // 親 clear 時に in-flight な variation fetch を破棄
      variationSeqRef.current += 1;
      setVariations([]);
      setLoadingVariations(false);
      return;
    }
    const mySeq = ++variationSeqRef.current;
    setLoadingVariations(true);
    setVariationError(null);
    fetchVariations(String(gid))
      .then((r) => {
        if (mySeq !== variationSeqRef.current) return;
        if (!r.ok) {
          setVariationError(r.error ?? '取得失敗');
          setVariations([]);
          return;
        }
        const arr = r.variations ?? [];
        setVariations(arr);
        // 0 件: variation_id=null のまま
        // 1 件: 自動選択
        // 2 件以上: ユーザー選択待ち
        if (arr.length === 1 && value.variation_id == null) {
          const v = arr[0];
          const vid = toIntId(v.id);
          onChange({
            parent_group_id: value.parent_group_id,
            parent_group_name: value.parent_group_name,
            variation_id: vid,
            variation_name: formatVariationName(v),
            variation_text: v.variation,
            variation_jan: v.jan_code,
          });
        }
      })
      .finally(() => {
        if (mySeq === variationSeqRef.current) setLoadingVariations(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.parent_group_id, context, manualMode]);

  function pickGroup(item: SuggestGroupItem) {
    const intId = toIntId(item.id);
    if (intId == null) {
      // 数値化失敗 → 手入力扱い
      onChange({
        parent_group_id: null,
        parent_group_name: '',
        variation_id: null,
        variation_name: item.group_name,
        variation_text: null,
        variation_jan: null,
      });
      setManualMode(true);
      setQ('');
      setItems([]);
      setOpen(false);
      return;
    }
    // 子バリエーション選択前の暫定 variation_name は親 group_name にフォールバック。
    // 子 0 件のグループでも record-form の product_name_text NOT NULL を満たして保存できる。
    // 子を picker で選択した時点で pickVariation() が上書きする。
    onChange({
      parent_group_id: intId,
      parent_group_name: item.group_name,
      variation_id: null,
      variation_name: item.group_name,
      variation_text: null,
      variation_jan: null,
    });
    setQ('');
    setItems([]);
    setOpen(false);
    setVariations([]);
  }

  function pickVariation(v: VariationItem) {
    const vid = toIntId(v.id);
    onChange({
      parent_group_id: value.parent_group_id,
      parent_group_name: value.parent_group_name,
      variation_id: vid,
      variation_name: formatVariationName(v),
      variation_text: v.variation,
      variation_jan: v.jan_code,
    });
  }

  function clearSelection() {
    onChange({
      parent_group_id: null,
      parent_group_name: '',
      variation_id: null,
      variation_name: '',
      variation_text: null,
      variation_jan: null,
    });
    setQ('');
    setItems([]);
    setVariations([]);
  }

  function enterManual() {
    setManualMode(true);
    setQ('');
    setItems([]);
    setOpen(false);
  }

  function backToSearch() {
    setManualMode(false);
    onChange({
      parent_group_id: null,
      parent_group_name: '',
      variation_id: null,
      variation_name: '',
      variation_text: null,
      variation_jan: null,
    });
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
        {context === 'record' ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <input
              type="text"
              name="product_name_text"
              value={value.variation_name}
              onChange={(e) =>
                onChange({
                  ...value,
                  parent_group_id: null,
                  variation_id: null,
                  variation_name: e.target.value,
                })
              }
              placeholder="商品名 (必須)"
              required={required}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
            />
            <input
              type="text"
              name="variation_jan"
              value={value.variation_jan ?? ''}
              onChange={(e) =>
                onChange({ ...value, variation_jan: e.target.value || null })
              }
              placeholder="JAN (任意)"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
            />
          </div>
        ) : (
          <input
            type="text"
            name="product_name_text"
            value={value.variation_name}
            onChange={(e) =>
              onChange({
                ...value,
                parent_group_id: null,
                variation_id: null,
                variation_name: e.target.value,
              })
            }
            placeholder="商品名 (必須)"
            required={required}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
          />
        )}
        <p className="text-[10px] text-gray-400">
          Core 商品マスタに存在しない商品を入力する場合のみ使用してください
        </p>
      </div>
    );
  }

  // ---- 検索モード ----
  const hasParent = value.parent_group_id != null;

  return (
    <div className="space-y-2">
      <label className="block text-xs font-medium text-gray-600">
        {label}{required && <span className="text-rose-600 ml-1">*</span>}
      </label>
      {hasParent ? (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5 items-center">
            <span className="inline-flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 text-xs text-violet-700">
              <span className="font-medium">{value.parent_group_name || `id=${value.parent_group_id}`}</span>
              {value.variation_id != null && value.variation_name && (
                <span className="text-violet-500 ml-1">/ {value.variation_name}</span>
              )}
              {value.variation_jan && (
                <span className="text-violet-400 ml-1">JAN={value.variation_jan}</span>
              )}
              <span className="text-violet-400 ml-1">group_id={value.parent_group_id}</span>
              {value.variation_id != null && (
                <span className="text-violet-400 ml-0.5">/variation_id={value.variation_id}</span>
              )}
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
          {context === 'record' && (
            <div>
              {loadingVariations && (
                <p className="text-[11px] text-gray-500">バリエーション取得中…</p>
              )}
              {variationError && (
                <p className="text-[11px] text-rose-600">バリエーション取得失敗: {variationError}</p>
              )}
              {!loadingVariations && !variationError && variations.length === 0 && (
                <p className="text-[11px] text-gray-400">バリエーション無し (親のみ)</p>
              )}
              {!loadingVariations && !variationError && variations.length >= 2 && (
                <div>
                  <label className="block text-[11px] text-gray-500 mb-1">バリエーション選択</label>
                  <select
                    value={value.variation_id != null ? String(value.variation_id) : ''}
                    onChange={(e) => {
                      const id = e.target.value;
                      if (!id) {
                        onChange({
                          ...value,
                          variation_id: null,
                          variation_name: '',
                          variation_jan: null,
                        });
                        return;
                      }
                      const v = variations.find((x) => x.id === id);
                      if (v) pickVariation(v);
                    }}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
                  >
                    <option value="">(選択してください)</option>
                    {variations.map((v) => (
                      <option key={v.id} value={v.id}>
                        {formatVariationName(v)}{v.jan_code ? ` (JAN: ${v.jan_code})` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {!loadingVariations && !variationError && variations.length === 1 && value.variation_id != null && (
                <p className="text-[11px] text-gray-400">バリエーション 1 件 (自動選択済み)</p>
              )}
            </div>
          )}
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
            placeholder="商品名で検索 (Core 親グループマスタ)"
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
                  onMouseDown={() => pickGroup(item)}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-gray-50 border-b border-gray-100 last:border-b-0"
                >
                  <span className="text-gray-900">{item.group_name}</span>
                  {item.developer && (
                    <span className="text-gray-500 ml-1">/ {item.developer}</span>
                  )}
                  <span className="text-gray-400 ml-2">id={item.id}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {allowManualInput && !hasParent && (
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
