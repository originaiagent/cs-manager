'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { X, Edit3, Hash } from 'lucide-react';
import type { CustomerRecord } from './records-table-client';

interface Props {
  record: CustomerRecord | null;
  onClose: () => void;
}

const ACTION_LABEL: Record<string, string> = {
  reply_only: '返信のみ',
  reship_defect: '不良で再送',
  refund_defect: '不良で返金',
  reship_customer: '客都合で再送',
  addon_send: '追加発送',
  relation_send: '関係性発送',
};

function formatCreatedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function formatYen(n: number | null): string {
  if (n == null) return '-';
  return `¥${n.toLocaleString('ja-JP')}`;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-3 border-b border-gray-100 px-5 py-2.5 last:border-b-0">
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="col-span-2 text-sm text-gray-800">{children}</dd>
    </div>
  );
}

export default function RecordDetailModal({ record, onClose }: Props) {
  useEffect(() => {
    if (!record) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [record, onClose]);

  if (!record) return null;

  const productLine = (
    <div>
      <div className="font-medium text-gray-900">{record.product_name_text}</div>
      {record.variation_text && (
        <div className="text-[11px] text-gray-500 mt-0.5">{record.variation_text}</div>
      )}
      {record.variation_jan && (
        <div className="text-[10px] text-gray-400 mt-0.5">JAN: {record.variation_jan}</div>
      )}
      {(record.product_id != null || record.variation_id != null) && (
        <div className="text-[10px] text-gray-400 mt-0.5 inline-flex items-center gap-1">
          <Hash size={10} />
          {record.product_id != null && <span>group={record.product_id}</span>}
          {record.variation_id != null && <span>/variation={record.variation_id}</span>}
        </div>
      )}
    </div>
  );

  const orderLine =
    record.order_number || record.order_channel ? (
      <span className="tabular-nums">
        {record.order_number ?? '-'}
        {record.order_channel ? (
          <span className="text-gray-400 text-xs ml-1">({record.order_channel})</span>
        ) : null}
      </span>
    ) : (
      <span className="text-gray-300">-</span>
    );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-2xl rounded-xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">対応記録 詳細</h2>
            <p className="text-[11px] text-gray-500 mt-0.5">
              {record.record_date} ・ {ACTION_LABEL[record.action_type] ?? record.action_type}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
            aria-label="閉じる"
          >
            <X size={16} />
          </button>
        </div>

        <dl className="max-h-[70vh] overflow-y-auto">
          <Row label="日付">
            <span className="tabular-nums">{record.record_date}</span>
          </Row>
          <Row label="商品">{productLine}</Row>
          <Row label="受取人">
            {record.recipient_name}
            {record.recipient_honorific && (
              <span className="text-gray-400 text-xs ml-0.5">{record.recipient_honorific}</span>
            )}
          </Row>
          <Row label="注文">{orderLine}</Row>
          <Row label="対応種別">
            <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px]">
              {ACTION_LABEL[record.action_type] ?? record.action_type}
            </span>
            <span className="text-gray-400 text-[11px] ml-2">({record.action_type})</span>
          </Row>
          <Row label="不良内容">
            {record.defect_type ? (
              <span className="text-rose-700 text-xs">{record.defect_type}</span>
            ) : (
              <span className="text-gray-300">-</span>
            )}
          </Row>
          <Row label="Amazonギフト額">
            <span className="tabular-nums">{formatYen(record.amazon_gift_amount)}</span>
          </Row>
          <Row label="再送追跡番号">
            {record.reship_tracking ? (
              <span className="tabular-nums">{record.reship_tracking}</span>
            ) : (
              <span className="text-gray-300">-</span>
            )}
          </Row>
          <Row label="LINEアカウント">
            {record.line_account ?? <span className="text-gray-300">-</span>}
          </Row>
          <Row label="メモ">
            {record.memo ? (
              <div className="whitespace-pre-wrap text-gray-700">{record.memo}</div>
            ) : (
              <span className="text-gray-300">-</span>
            )}
          </Row>
          <Row label="関連チケット">
            {record.ticket_id ? (
              <Link
                href={`/tickets/${record.ticket_id}`}
                className="text-xs text-brand-700 hover:underline"
              >
                チケット
              </Link>
            ) : (
              <span className="text-gray-300">-</span>
            )}
          </Row>
          <Row label="ID">
            <span className="font-mono text-[11px] text-gray-500">{record.id}</span>
          </Row>
          <Row label="作成日時">
            <span className="tabular-nums text-gray-600 text-xs">
              {formatCreatedAt(record.created_at)}
            </span>
          </Row>
        </dl>

        <div className="flex items-center justify-end gap-2 border-t border-gray-200 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            閉じる
          </button>
          <Link
            href={`/customer-records/${record.id}`}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-600"
          >
            <Edit3 size={14} />
            編集
          </Link>
        </div>
      </div>
    </div>
  );
}
