'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles, Save, Loader2, RefreshCw, Pencil, Check } from 'lucide-react';
import { generateAiDraft } from '../_actions/generate-ai-draft';
import { saveDraft } from '../_actions/save-draft';

interface Props {
  ticketId: string;
  initialBody: string;
  initialSource: string | null;
  productAvailable: boolean;
}

type AiState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'preview'; draft: string; durationMs: number }
  | { kind: 'error'; error: string };

export default function ReplyForm({
  ticketId,
  initialBody,
  initialSource,
  productAvailable,
}: Props) {
  const router = useRouter();
  const [body, setBody] = useState(initialBody);
  const [source, setSource] = useState<string | null>(initialSource);
  const [savingManual, setSavingManual] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [ai, setAi] = useState<AiState>({ kind: 'idle' });
  const [, startTransition] = useTransition();

  async function saveManual() {
    if (!body.trim() || savingManual) return;
    setSavingManual(true);
    setSaveError(null);
    try {
      const result = await saveDraft(ticketId, body, 'manual');
      if (!result.ok) {
        throw new Error(result.error ?? 'save failed');
      }
      setSavedAt(new Date().toISOString());
      setSource('manual');
      startTransition(() => router.refresh());
    } catch (e: any) {
      setSaveError(e?.message ?? 'unknown error');
    } finally {
      setSavingManual(false);
    }
  }

  async function generateAi() {
    setAi({ kind: 'loading' });
    const startedAt = Date.now();
    const result = await generateAiDraft(ticketId);
    if (!result.ok || typeof result.draft !== 'string') {
      setAi({ kind: 'error', error: result.error ?? 'unknown error' });
      return;
    }
    setAi({
      kind: 'preview',
      draft: result.draft,
      durationMs: result.durationMs ?? Date.now() - startedAt,
    });
  }

  async function adoptAiDraft() {
    if (ai.kind !== 'preview') return;
    setBody(ai.draft);
    setSource('ai_draft');
    setAi({ kind: 'idle' });
    // 採用 = ai_draft で永続化
    try {
      const r = await saveDraft(ticketId, ai.draft, 'ai_draft');
      if (!r.ok) {
        setSaveError(r.error ?? '保存に失敗しました');
        return;
      }
      setSavedAt(new Date().toISOString());
      startTransition(() => router.refresh());
    } catch (e: any) {
      setSaveError(e?.message ?? '保存に失敗しました');
    }
  }

  function editAiDraft() {
    if (ai.kind !== 'preview') return;
    setBody(ai.draft);
    setSource('ai_draft');
    setAi({ kind: 'idle' });
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-900">返信</h3>
        <div className="flex items-center gap-2">
          {source && (
            <span className="text-[10px] text-gray-400">
              下書きソース: {source === 'ai_draft' ? 'AI生成' : '手動'}
            </span>
          )}
          {savedAt && (
            <span className="text-[10px] text-emerald-600">
              {new Date(savedAt).toLocaleTimeString('ja-JP')} 保存済み
            </span>
          )}
        </div>
      </div>

      {/* AIドラフトプレビュー */}
      {ai.kind === 'loading' && (
        <div className="mb-3 rounded-lg border border-brand-100 bg-brand-50/50 p-4 flex items-center gap-3">
          <Loader2 size={16} className="animate-spin text-brand-500" />
          <span className="text-sm text-brand-700">AI が返信ドラフトを生成中…</span>
        </div>
      )}
      {ai.kind === 'preview' && (
        <div className="mb-3 rounded-lg border border-brand-200 bg-brand-50/50 p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-brand-700 inline-flex items-center gap-1">
              <Sparkles size={14} /> AI ドラフトプレビュー
            </span>
            <span className="text-[10px] text-gray-500">{ai.durationMs} ms</span>
          </div>
          <pre className="whitespace-pre-wrap text-sm text-gray-800 font-sans bg-white rounded-md border border-brand-100 p-3 max-h-64 overflow-auto">
            {ai.draft}
          </pre>
          <div className="flex flex-wrap gap-2 mt-3">
            <button
              type="button"
              onClick={generateAi}
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
            >
              <RefreshCw size={12} /> 再生成
            </button>
            <button
              type="button"
              onClick={editAiDraft}
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
            >
              <Pencil size={12} /> 編集
            </button>
            <button
              type="button"
              onClick={adoptAiDraft}
              className="inline-flex items-center gap-1.5 rounded-md bg-brand-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-600"
            >
              <Check size={12} /> 採用
            </button>
          </div>
        </div>
      )}
      {ai.kind === 'error' && (
        <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">
          AI 生成失敗: {ai.error}
          <button
            onClick={generateAi}
            className="ml-2 underline hover:no-underline"
          >
            再試行
          </button>
        </div>
      )}

      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={8}
        placeholder="返信本文を入力してください"
        className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none resize-y min-h-[140px]"
      />

      <div className="flex items-center justify-between gap-3 mt-3">
        <button
          type="button"
          onClick={generateAi}
          disabled={ai.kind === 'loading'}
          title={!productAvailable ? '製品情報なしで生成します' : undefined}
          className="inline-flex items-center gap-2 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm font-medium text-brand-700 hover:bg-brand-100 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Sparkles size={14} />
          {ai.kind === 'loading' ? '生成中…' : 'AI ドラフト生成'}
        </button>

        <div className="flex items-center gap-2">
          {saveError && (
            <span className="text-[11px] text-rose-600">{saveError}</span>
          )}
          <button
            type="button"
            onClick={saveManual}
            disabled={savingManual || !body.trim()}
            className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {savingManual ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Save size={14} />
            )}
            下書き保存
          </button>
        </div>
      </div>

      <p className="text-[11px] text-gray-400 mt-3">
        ※ 楽天への実送信は本フェーズでは未対応です。下書きは ticket_drafts に保存されます。
      </p>
    </div>
  );
}
