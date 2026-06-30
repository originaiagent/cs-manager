'use client';

// 〔これじゃない〕UI部品 (cs-manager)。origin-ai SoT 契約 (verdict='not_this' / reason任意) に準拠。
// 小ボタン + 押下時のみ出る任意理由欄。送信は Server Action submitNotThisFeedbackAction
// (鍵は server-only 注入)。返信下書き画面では <NotThisButton runId={rag.runId} /> の1行で貼れる。

import { useState } from 'react';
import { ThumbsDown, Loader2, Check } from 'lucide-react';
import { submitNotThisFeedbackAction } from '../_actions/submit-not-this-feedback';

type Phase = 'idle' | 'open' | 'sending' | 'done' | 'error';

export default function NotThisButton({
  runId,
  label = 'これじゃない',
}: {
  /** ai_embed_runs.id。空なら描画しない (run識別子が無い古いドラフト等)。 */
  runId: string | null | undefined;
  label?: string;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [reason, setReason] = useState('');
  const [errMsg, setErrMsg] = useState<string | null>(null);

  if (!runId) return null;

  if (phase === 'done') {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs text-gray-500"
        data-testid="not-this-done"
      >
        <Check className="h-3 w-3" /> フィードバック受領
      </span>
    );
  }

  async function send() {
    setPhase('sending');
    setErrMsg(null);
    try {
      const res = await submitNotThisFeedbackAction(runId as string, reason.trim() || null);
      if (res.ok) {
        setPhase('done');
      } else {
        setPhase('error');
        setErrMsg(res.error ?? '送信に失敗しました');
      }
    } catch {
      setPhase('error');
      setErrMsg('送信に失敗しました');
    }
  }

  return (
    <span className="inline-flex flex-col gap-1" data-testid="not-this-root">
      {phase === 'idle' || phase === 'error' ? (
        <button
          type="button"
          onClick={() => setPhase('open')}
          className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
          data-testid="not-this-button"
        >
          <ThumbsDown className="h-3 w-3" /> 〔{label}〕
        </button>
      ) : null}

      {phase === 'open' || phase === 'sending' ? (
        <span className="flex flex-col gap-1" data-testid="not-this-form">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="理由(任意)。※社外秘・個人情報は書かないでください"
            className="w-64 rounded border border-gray-300 p-1 text-xs"
            data-testid="not-this-reason"
            disabled={phase === 'sending'}
          />
          <span className="flex gap-2">
            <button
              type="button"
              onClick={send}
              disabled={phase === 'sending'}
              className="inline-flex items-center gap-1 rounded bg-gray-800 px-2 py-1 text-xs text-white hover:bg-gray-700 disabled:opacity-50"
              data-testid="not-this-submit"
            >
              {phase === 'sending' ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              {phase === 'sending' ? '送信中…' : '送信'}
            </button>
            <button
              type="button"
              onClick={() => {
                setPhase('idle');
                setReason('');
              }}
              disabled={phase === 'sending'}
              className="rounded px-2 py-1 text-xs text-gray-500 hover:underline"
              data-testid="not-this-cancel"
            >
              やめる
            </button>
          </span>
        </span>
      ) : null}

      {phase === 'error' && errMsg ? (
        <span className="text-xs text-red-600" data-testid="not-this-error">
          {errMsg}
        </span>
      ) : null}
    </span>
  );
}
