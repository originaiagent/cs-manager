'use client';

/**
 * 社内枠「関連ナレッジ候補」の Info アイコン押下で開くメタ表示ポップオーバー。
 *
 * - **client component / 表示専用**: props で渡されたメタ (groundingArticles 由来) のみ表示。
 *   client から DB / API アクセスは一切しない (社内 read-only)。
 * - 表示項目: タイトル / 想定問い合わせ(question) / 対応方針(answer) / ステータス(status)。
 * - 詳細ページ /knowledge/<full-id> へのリンクを含む (full UUID)。
 * - 内部マーカー / ナレーションは扱わない (構造化済みメタのみ受け取る)。
 */

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { X, ExternalLink } from 'lucide-react';

export interface KnowledgeMetaPopoverProps {
  /** 記事 full UUID (/knowledge/<id> リンク用)。 */
  id: string;
  title: string | null;
  question: string | null;
  answer: string | null;
  status: string | null;
  onClose: () => void;
}

const STATUS_LABELS: Record<string, string> = {
  published: '公開',
  draft: '下書き',
};

export default function KnowledgeMetaPopover({
  id,
  title,
  question,
  answer,
  status,
  onClose,
}: KnowledgeMetaPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);

  // Esc / 外側クリックで閉じる (read-only オーバーレイ)。
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClickOutside);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClickOutside);
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="ナレッジ記事の詳細"
        className="w-full max-w-md rounded-xl border border-gray-200 bg-white shadow-xl"
      >
        <div className="flex items-start justify-between gap-2 border-b border-gray-100 px-4 py-3">
          <h4 className="text-sm font-semibold text-gray-900 break-words">
            {title?.trim() || '(タイトルなし)'}
          </h4>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="shrink-0 rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3 px-4 py-3 max-h-[60vh] overflow-auto">
          <div>
            <p className="text-[10px] font-semibold tracking-wider text-gray-400 mb-1">
              想定問い合わせ
            </p>
            <p className="text-[13px] text-gray-800 whitespace-pre-wrap">
              {question?.trim() || '—'}
            </p>
          </div>
          <div>
            <p className="text-[10px] font-semibold tracking-wider text-gray-400 mb-1">
              対応方針
            </p>
            <p className="text-[13px] text-gray-800 whitespace-pre-wrap">
              {answer?.trim() || '—'}
            </p>
          </div>
          <div>
            <p className="text-[10px] font-semibold tracking-wider text-gray-400 mb-1">
              ステータス
            </p>
            <p className="text-[13px] text-gray-800">
              {status ? STATUS_LABELS[status] ?? status : '—'}
            </p>
          </div>
        </div>

        <div className="border-t border-gray-100 px-4 py-3">
          <Link
            href={`/knowledge/${id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-indigo-600 hover:text-indigo-800"
          >
            <ExternalLink size={13} /> ナレッジ詳細を開く
          </Link>
        </div>
      </div>
    </div>
  );
}
