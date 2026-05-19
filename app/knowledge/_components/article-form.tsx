'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition, type FormEvent } from 'react';
import { Save, Loader2 } from 'lucide-react';
import ProductSuggest from './product-suggest';
import ProductPicker, { type ProductPickerValue } from '@/app/_components/product-picker';
import { createArticle } from '../_actions/create-article';
import { updateArticle } from '../_actions/update-article';

interface ChannelOption {
  code: string;
  display_name: string;
}

interface InitialValues {
  id?: string;
  storage_scope: 'company' | 'store' | 'product';
  storage_store_id: string | null;
  storage_product_id: string | null;
  applies_to_stores: string[];
  applies_to_products: string[];
  applies_to_categories: string[];
  applies_to_defect_types: string[];
  title: string;
  question: string | null;
  answer: string | null;
  body_markdown: string | null;
  tags: string[];
  status: 'draft' | 'published';
  resolved_product_name?: string | null;
  resolved_product_group_name?: string | null;
}

interface Props {
  channels: ChannelOption[];
  initial?: Partial<InitialValues>;
  mode: 'create' | 'edit';
}

const SCOPES = [
  { value: 'company', label: '会社共通' },
  { value: 'store', label: '店舗共通' },
  { value: 'product', label: '商品別' },
] as const;

const CATEGORIES = ['defect', 'shipping', 'usage', 'other'];
const DEFECT_TYPES = ['size_mismatch', 'color_mismatch', 'damaged', 'missing_part', 'other'];

export default function ArticleForm({ channels, initial, mode }: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [scope, setScope] = useState<'company' | 'store' | 'product'>(
    (initial?.storage_scope as any) ?? 'company',
  );
  const [storeId, setStoreId] = useState(initial?.storage_store_id ?? '');
  const [productId, setProductId] = useState(initial?.storage_product_id ?? '');
  // 親グループ picker 用 value (scope='product' のとき使用)
  const [productPickerValue, setProductPickerValue] = useState<ProductPickerValue>(() => ({
    parent_group_id: initial?.storage_product_id ? Number(initial.storage_product_id) || null : null,
    parent_group_name: initial?.resolved_product_group_name ?? '',
    variation_id: null,
    variation_name: initial?.resolved_product_group_name ?? '',
    variation_text: null,
    variation_jan: null,
  }));
  const [appliesStores, setAppliesStores] = useState<string[]>(
    initial?.applies_to_stores ?? [],
  );
  const [appliesProducts, setAppliesProducts] = useState<string[]>(
    initial?.applies_to_products ?? [],
  );
  const [appliesCats, setAppliesCats] = useState<string[]>(
    initial?.applies_to_categories ?? [],
  );
  const [appliesDefects, setAppliesDefects] = useState<string[]>(
    initial?.applies_to_defect_types ?? [],
  );

  const [title, setTitle] = useState(initial?.title ?? '');
  const [question, setQuestion] = useState(initial?.question ?? '');
  const [answer, setAnswer] = useState(initial?.answer ?? '');
  const [bodyMd, setBodyMd] = useState(initial?.body_markdown ?? '');
  const [tagsText, setTagsText] = useState((initial?.tags ?? []).join(', '));
  const [status, setStatus] = useState<'draft' | 'published'>(
    initial?.status === 'published' ? 'published' : 'draft',
  );

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleArr(arr: string[], val: string): string[] {
    return arr.includes(val) ? arr.filter((x) => x !== val) : [...arr, val];
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const payload = {
      storage_scope: scope,
      storage_store_id: scope === 'store' ? storeId || null : null,
      storage_product_id: scope === 'product' ? productId || null : null,
      applies_to_stores: appliesStores,
      applies_to_products: appliesProducts,
      applies_to_categories: appliesCats,
      applies_to_defect_types: appliesDefects,
      title: title.trim(),
      question: question.trim() || null,
      answer: answer.trim() || null,
      body_markdown: bodyMd.trim() || null,
      tags: tagsText
        .split(/[,、]/)
        .map((s) => s.trim())
        .filter(Boolean),
      status,
    };
    if (!payload.title) {
      setError('タイトルは必須です');
      setSaving(false);
      return;
    }
    if (scope === 'store' && !storeId) {
      setError('店舗共通スコープでは店舗IDが必須です');
      setSaving(false);
      return;
    }
    if (scope === 'product' && !productId) {
      setError('商品別スコープでは商品IDが必須です');
      setSaving(false);
      return;
    }
    try {
      const result =
        mode === 'edit'
          ? await updateArticle(initial!.id!, payload)
          : await createArticle(payload);
      if (!result.ok) throw new Error(result.error ?? '保存失敗');
      const id = result.article?.id ?? initial?.id;
      startTransition(() => router.push(`/knowledge/${id}`));
    } catch (e: any) {
      setError(e?.message ?? 'unknown error');
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      {/* スコープ */}
      <section>
        <label className="block text-xs font-medium text-gray-600 mb-2">スコープ</label>
        <div className="flex gap-2 mb-3">
          {SCOPES.map((s) => (
            <button
              type="button"
              key={s.value}
              onClick={() => setScope(s.value as any)}
              className={`px-3 py-1.5 rounded-full border text-xs ${
                scope === s.value
                  ? 'bg-brand-500 text-white border-brand-500'
                  : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        {scope === 'store' && (
          <select
            value={storeId ?? ''}
            onChange={(e) => setStoreId(e.target.value)}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
          >
            <option value="">店舗を選択…</option>
            {channels.map((c) => (
              <option key={c.code} value={c.code}>
                {c.display_name}
              </option>
            ))}
          </select>
        )}
        {scope === 'product' && (
          <ProductPicker
            value={productPickerValue}
            onChange={(v) => {
              setProductPickerValue(v);
              setProductId(v.parent_group_id != null ? String(v.parent_group_id) : '');
            }}
            context="knowledge"
            label="所有 商品グループ (1つ)"
            required
            allowManualInput={false}
          />
        )}
      </section>

      {/* タイトル */}
      <section>
        <label className="block text-xs font-medium text-gray-600 mb-1">タイトル *</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
        />
      </section>

      {/* Q&A */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Question</label>
          <textarea
            rows={3}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Answer</label>
          <textarea
            rows={3}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
          />
        </div>
      </section>

      {/* Body */}
      <section>
        <label className="block text-xs font-medium text-gray-600 mb-1">本文 (Markdown)</label>
        <textarea
          rows={6}
          value={bodyMd}
          onChange={(e) => setBodyMd(e.target.value)}
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm font-mono"
        />
      </section>

      {/* 適用範囲 */}
      <section className="space-y-3 rounded-xl border border-gray-200 bg-white p-4">
        <p className="text-[11px] text-gray-400 font-medium tracking-wider">APPLIES TO (適用範囲)</p>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1.5">店舗 (複数選択可)</label>
          <div className="flex flex-wrap gap-1.5">
            {channels.map((c) => {
              const active = appliesStores.includes(c.code);
              return (
                <button
                  type="button"
                  key={c.code}
                  onClick={() => setAppliesStores(toggleArr(appliesStores, c.code))}
                  className={`px-2.5 py-1 rounded-full border text-[11px] ${
                    active
                      ? 'bg-pink-50 text-pink-700 border-pink-200'
                      : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  {c.display_name}
                </button>
              );
            })}
          </div>
        </div>

        <ProductSuggest
          label="製品 (複数選択可)"
          selected={appliesProducts}
          onChange={setAppliesProducts}
        />

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1.5">ケース</label>
          <div className="flex flex-wrap gap-1.5">
            {CATEGORIES.map((c) => {
              const active = appliesCats.includes(c);
              return (
                <button
                  type="button"
                  key={c}
                  onClick={() => setAppliesCats(toggleArr(appliesCats, c))}
                  className={`px-2.5 py-1 rounded-full border text-[11px] ${
                    active
                      ? 'bg-gray-900 text-white border-gray-900'
                      : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  {c}
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1.5">不良種別</label>
          <div className="flex flex-wrap gap-1.5">
            {DEFECT_TYPES.map((d) => {
              const active = appliesDefects.includes(d);
              return (
                <button
                  type="button"
                  key={d}
                  onClick={() => setAppliesDefects(toggleArr(appliesDefects, d))}
                  className={`px-2.5 py-1 rounded-full border text-[11px] ${
                    active
                      ? 'bg-amber-50 text-amber-700 border-amber-200'
                      : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  {d}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* タグ + ステータス */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">タグ (カンマ区切り)</label>
          <input
            type="text"
            value={tagsText}
            onChange={(e) => setTagsText(e.target.value)}
            placeholder="返品, 公式, ガイドライン"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">ステータス</label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as 'draft' | 'published')}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
          >
            <option value="draft">下書き</option>
            <option value="published">公開中</option>
          </select>
        </div>
      </section>

      {error && (
        <p className="text-xs text-rose-600 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => router.back()}
          className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
        >
          キャンセル
        </button>
        <button
          type="submit"
          disabled={saving || !title.trim()}
          className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {mode === 'edit' ? '保存' : '作成'}
        </button>
      </div>
    </form>
  );
}
