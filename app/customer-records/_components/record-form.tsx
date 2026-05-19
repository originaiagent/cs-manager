'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Save, Trash2 } from 'lucide-react';
import { createRecord, type CreateRecordPayload } from '../_actions/create-record';
import { updateRecord } from '../_actions/update-record';
import { deleteRecord } from '../_actions/delete-record';
import { listDefectTypes } from '../_actions/list-defect-types';
import ProductPicker, { type ProductPickerValue } from '@/app/_components/product-picker';

const ACTION_TYPE_OPTIONS = [
  { value: 'reply_only', label: '返信のみ' },
  { value: 'reship_defect', label: '不良で再送' },
  { value: 'refund_defect', label: '不良で返金' },
  { value: 'reship_customer', label: 'お客様都合で再送' },
  { value: 'addon_send', label: '追加発送' },
  { value: 'relation_send', label: '関係性発送' },
];

const ORDER_CHANNEL_OPTIONS = [
  { value: '', label: '(未指定)' },
  { value: 'amazon', label: 'Amazon' },
  { value: 'rakuten', label: '楽天' },
  { value: 'yahoo', label: 'Yahoo' },
  { value: 'self', label: '自社EC' },
  { value: 'other', label: 'その他' },
];

export interface RecordFormInitial {
  id?: string;
  product_id?: number | null;
  product_name_text?: string;
  variation_text?: string | null;
  variation_id?: number | null;
  variation_jan?: string | null;
  recipient_name?: string;
  recipient_honorific?: string;
  order_number?: string | null;
  order_channel?: string | null;
  action_type?: string;
  amazon_gift_amount?: number | null;
  reship_tracking?: string | null;
  record_date?: string;
  line_account?: string | null;
  memo?: string | null;
  defect_type?: string | null;
  ticket_id?: string | null;
}

interface Props {
  mode: 'create' | 'edit';
  initial?: RecordFormInitial;
  defaultTicketId?: string | null;
  defaultRecipientName?: string | null;
  defaultProductName?: string | null;
}

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function RecordForm({
  mode,
  initial,
  defaultTicketId,
  defaultRecipientName,
  defaultProductName,
}: Props) {
  const router = useRouter();
  const [productPickerValue, setProductPickerValue] = useState<ProductPickerValue>(() => {
    // 既存編集互換:
    //   variation_id あり: 検索モード+選択済み (親 group_id も Core で動的解決)
    //   product_id (旧) のみ: 手入力モードで開く (product_name_text スナップショット表示)
    //   完全に空 (新規): 検索モード+検索 box
    if (initial?.variation_id != null) {
      return {
        parent_group_id: initial.product_id ?? null,
        parent_group_name: '',
        variation_id: initial.variation_id,
        variation_name: initial.product_name_text ?? '',
        variation_text: initial.variation_text ?? null,
        variation_jan: initial.variation_jan ?? null,
      };
    }
    if (initial?.product_id != null) {
      // 親 group のみ保存 (子バリエーション未選択) OR 旧スキーマ。
      // 新スキーマ運用では product_id = 親 group_id。Core が解決できなければ picker が「id=X」fallback 表示。
      // 旧スキーマ (child product.id) のレコードは scripts/migrate-customer-records-to-parent.ts で正規化想定。
      return {
        parent_group_id: initial.product_id,
        parent_group_name: '',
        variation_id: null,
        variation_name: initial.product_name_text ?? '',
        variation_text: initial.variation_text ?? null,
        variation_jan: null,
      };
    }
    return {
      parent_group_id: null,
      parent_group_name: '',
      variation_id: null,
      variation_name: initial?.product_name_text ?? defaultProductName ?? '',
      variation_text: initial?.variation_text ?? null,
      variation_jan: null,
    };
  });
  const [recipientName, setRecipientName] = useState(
    initial?.recipient_name ?? defaultRecipientName ?? '',
  );
  const [recipientHonorific, setRecipientHonorific] = useState(initial?.recipient_honorific ?? '様');
  const [orderNumber, setOrderNumber] = useState(initial?.order_number ?? '');
  const [orderChannel, setOrderChannel] = useState(initial?.order_channel ?? '');
  const [actionType, setActionType] = useState(initial?.action_type ?? 'reply_only');
  const [amazonGift, setAmazonGift] = useState(
    initial?.amazon_gift_amount != null ? String(initial.amazon_gift_amount) : '',
  );
  const [reshipTracking, setReshipTracking] = useState(initial?.reship_tracking ?? '');
  const [recordDate, setRecordDate] = useState(initial?.record_date ?? todayYmd());
  const [lineAccount, setLineAccount] = useState(initial?.line_account ?? '');
  const [memo, setMemo] = useState(initial?.memo ?? '');
  const [defectType, setDefectType] = useState(initial?.defect_type ?? '');
  const ticketId = initial?.ticket_id ?? defaultTicketId ?? null;

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [defectSuggestions, setDefectSuggestions] = useState<string[]>([]);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    listDefectTypes().then((r) => {
      if (r.ok && r.items) setDefectSuggestions(r.items);
    });
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);

    if (!productPickerValue.variation_name.trim()) {
      setError('商品名は必須です');
      setSubmitting(false);
      return;
    }

    const payload: CreateRecordPayload = {
      product_id: productPickerValue.parent_group_id,        // 親 group_id
      product_name_text: productPickerValue.variation_name,   // 子 product_name または手入力名
      variation_text: productPickerValue.variation_text,      // 子 variation 文字列 (defect-rate 分析用)
      variation_id: productPickerValue.variation_id,
      variation_jan: productPickerValue.variation_jan,
      recipient_name: recipientName,
      recipient_honorific: recipientHonorific || '様',
      order_number: orderNumber || null,
      order_channel: orderChannel || null,
      action_type: actionType,
      amazon_gift_amount: amazonGift.trim() ? Number(amazonGift.trim()) : null,
      reship_tracking: reshipTracking || null,
      record_date: recordDate,
      line_account: lineAccount || null,
      memo: memo || null,
      defect_type: defectType || null,
      ticket_id: ticketId || null,
    };

    const result =
      mode === 'create'
        ? await createRecord(payload)
        : await updateRecord(initial!.id!, payload);

    if (!result.ok) {
      setError(result.error ?? '保存に失敗しました');
      setSubmitting(false);
      return;
    }
    router.push('/customer-records');
    router.refresh();
  }

  async function handleDelete() {
    if (mode !== 'edit' || !initial?.id) return;
    if (!confirm('この対応記録を削除しますか?')) return;
    setSubmitting(true);
    setError(null);
    const r = await deleteRecord(initial.id);
    if (!r.ok) {
      setError(r.error ?? '削除に失敗しました');
      setSubmitting(false);
      return;
    }
    router.push('/customer-records');
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-5 max-w-3xl">
      {ticketId && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          関連チケット: <span className="font-mono">{ticketId}</span>
          <input
            type="hidden"
            name="ticket_id"
            value={ticketId}
            data-testid="ticket-id-hidden"
          />
        </div>
      )}

      <section>
        <ProductPicker
          value={productPickerValue}
          onChange={setProductPickerValue}
          context="record"
          label="商品"
          required
          allowManualInput
        />
      </section>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Field label="受取人 *">
          <input
            type="text"
            name="recipient_name"
            value={recipientName}
            onChange={(e) => setRecipientName(e.target.value)}
            required
            className={inputCls}
          />
        </Field>
        <Field label="敬称">
          <input
            type="text"
            name="recipient_honorific"
            value={recipientHonorific}
            onChange={(e) => setRecipientHonorific(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label="日付 *">
          <input
            type="date"
            name="record_date"
            value={recordDate}
            onChange={(e) => setRecordDate(e.target.value)}
            required
            className={inputCls}
          />
        </Field>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Field label="注文番号">
          <input
            type="text"
            name="order_number"
            value={orderNumber}
            onChange={(e) => setOrderNumber(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label="注文チャネル">
          <select
            name="order_channel"
            value={orderChannel}
            onChange={(e) => setOrderChannel(e.target.value)}
            className={inputCls}
          >
            {ORDER_CHANNEL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="対応種別 *">
          <select
            name="action_type"
            value={actionType}
            onChange={(e) => setActionType(e.target.value)}
            required
            className={inputCls}
          >
            {ACTION_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Field label="アマギフ金額 (円)">
          <input
            type="text"
            inputMode="numeric"
            name="amazon_gift_amount"
            value={amazonGift}
            onChange={(e) => setAmazonGift(e.target.value.replace(/[^0-9.]/g, ''))}
            className={inputCls}
          />
        </Field>
        <Field label="再送追跡番号">
          <input
            type="text"
            name="reship_tracking"
            value={reshipTracking}
            onChange={(e) => setReshipTracking(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label="LINEアカウント">
          <input
            type="text"
            name="line_account"
            value={lineAccount}
            onChange={(e) => setLineAccount(e.target.value)}
            className={inputCls}
          />
        </Field>
      </section>

      <section className="grid grid-cols-1 gap-3">
        <Field label="不良内容 (空欄なら不良扱いしない)">
          <input
            type="text"
            name="defect_type"
            value={defectType}
            onChange={(e) => setDefectType(e.target.value)}
            list="defect-type-suggest"
            placeholder="例: カビが生えた / サイズ違い"
            className={inputCls}
          />
          <datalist id="defect-type-suggest">
            {defectSuggestions.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
        </Field>

        <Field label="メモ">
          <textarea
            name="memo"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            rows={4}
            className={`${inputCls} font-sans`}
          />
        </Field>
      </section>

      {error && (
        <p className="text-xs text-rose-600 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2">
          {error}
        </p>
      )}

      <div className="flex items-center justify-between gap-2 pt-2">
        <div>
          {mode === 'edit' && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={submitting}
              className="inline-flex items-center gap-2 rounded-lg border border-rose-200 bg-white px-3 py-2 text-sm text-rose-700 hover:bg-rose-50 disabled:opacity-50"
            >
              <Trash2 size={14} />
              削除
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => router.push('/customer-records')}
            className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            キャンセル
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {submitting ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {mode === 'edit' ? '保存' : '作成'}
          </button>
        </div>
      </div>
    </form>
  );
}

const inputCls =
  'w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-gray-600 mb-1">
        {label}
        {hint && <span className="ml-2 text-gray-400 font-normal">({hint})</span>}
      </span>
      {children}
    </label>
  );
}
