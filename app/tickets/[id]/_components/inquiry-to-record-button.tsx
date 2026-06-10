'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles } from 'lucide-react';
import { runInquiryToRecord } from '../_actions/run-inquiry-to-record';

interface Props {
  ticketId: string;
}

/**
 * 入口ボタン (契約 §3): 問い合わせ → 顧客対応記録 (customer_record) ドラフト起票。
 * 実需 work `oneshot:inquiry-to-customer-record` を origin-ai 経由で起動する。
 *
 * fail-closed:
 *   - 起動は Server Action (server-only env) 経由のみ。embed key はブラウザに出ない。
 *   - 鍵未配布時は Server Action が 503 由来のメッセージを返し、ボタンは無効化される。
 */
export default function InquiryToRecordButton({ ticketId }: Props) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    if (running) return;
    setRunning(true);
    setError(null);
    try {
      const result = await runInquiryToRecord(ticketId);
      if (!result.ok) {
        setError(result.error ?? 'AI 起票に失敗しました');
        return;
      }
      // 起票結果 (対応記録) を反映するため再取得。
      startTransition(() => router.refresh());
    } catch (e: any) {
      setError(e?.message ?? 'unknown error');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="inline-flex flex-col items-end">
      <button
        type="button"
        onClick={handleClick}
        disabled={running}
        className={`inline-flex items-center gap-1.5 rounded-lg border border-brand-100 bg-brand-50 px-3 py-2 text-xs text-brand-700 hover:bg-brand-100 ${
          running ? 'opacity-60 cursor-not-allowed' : ''
        }`}
      >
        <Sparkles size={14} />
        {running ? 'AI 起票中…' : 'AI で対応記録を起票'}
      </button>
      {error && <p className="text-[10px] text-rose-600 mt-1 max-w-[16rem] text-right">{error}</p>}
    </div>
  );
}
