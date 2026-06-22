'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  Save,
  Loader2,
  RefreshCw,
  Pencil,
  Check,
  BookOpen,
  AlertTriangle,
} from 'lucide-react';
import {
  generateRagDraft,
  type RagCitation,
} from '../_actions/generate-rag-draft';
import { saveDraft } from '../_actions/save-draft';

interface Props {
  ticketId: string;
  initialBody: string;
  initialSource: string | null;
  /** 製品情報の有無 (page.tsx から渡される。現状は表示制御に未使用だが互換のため受領) */
  productAvailable?: boolean;
}

type RagState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | {
      kind: 'preview';
      draft: string;
      citations: RagCitation[];
      confidence: number | null;
      needsHuman: boolean;
      noAnswer: boolean;
      searchHitCount: number;
      model: string | null;
      withinBusinessHours: boolean | null;
      lowConfidenceThreshold: number;
      durationMs: number;
    }
  | { kind: 'error'; error: string };

/** 低 confidence 警告の既定閾値 (サーバ rag_config 未取得時のみのフォールバック) */
const DEFAULT_LOW_CONFIDENCE_THRESHOLD = 0.5;

export default function ReplyForm({
  ticketId,
  initialBody,
  initialSource,
}: Props) {
  const router = useRouter();
  const [body, setBody] = useState(initialBody);
  const [source, setSource] = useState<string | null>(initialSource);
  const [savingManual, setSavingManual] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [rag, setRag] = useState<RagState>({ kind: 'idle' });
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

  async function generateRag() {
    setRag({ kind: 'loading' });
    const startedAt = Date.now();
    const result = await generateRagDraft(ticketId);
    if (!result.ok || typeof result.draft !== 'string') {
      setRag({ kind: 'error', error: result.error ?? 'unknown error' });
      return;
    }
    setRag({
      kind: 'preview',
      draft: result.draft,
      citations: result.citations ?? [],
      confidence: result.confidence ?? null,
      needsHuman: result.needsHuman ?? false,
      noAnswer: result.noAnswer ?? false,
      searchHitCount: result.searchHitCount ?? 0,
      model: result.model ?? null,
      withinBusinessHours: result.withinBusinessHours ?? null,
      lowConfidenceThreshold:
        result.lowConfidenceThreshold ?? DEFAULT_LOW_CONFIDENCE_THRESHOLD,
      durationMs: result.durationMs ?? Date.now() - startedAt,
    });
  }

  async function adoptRagDraft() {
    if (rag.kind !== 'preview') return;
    setBody(rag.draft);
    setSource('ai_draft');
    const adopted = rag.draft;
    setRag({ kind: 'idle' });
    // 採用 = source='ai_draft' (ナレッジ参照 AI ドラフト) で永続化
    try {
      const r = await saveDraft(ticketId, adopted, 'ai_draft');
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

  function editRagDraft() {
    if (rag.kind !== 'preview') return;
    setBody(rag.draft);
    setSource('ai_draft');
    setRag({ kind: 'idle' });
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-900">返信</h3>
        <div className="flex items-center gap-2">
          {source && (
            <span className="text-[10px] text-gray-400">
              下書きソース:{' '}
              {source === 'ai_draft'
                ? 'AI(ナレッジ参照)'
                : source === 'rag'
                  ? 'RAG返信案'
                  : '手動'}
            </span>
          )}
          {savedAt && (
            <span className="text-[10px] text-emerald-600">
              {new Date(savedAt).toLocaleTimeString('ja-JP')} 保存済み
            </span>
          )}
        </div>
      </div>

      {/* 返信案プレビュー (ナレッジ参照) */}
      {rag.kind === 'loading' && (
        <div className="mb-3 rounded-lg border border-indigo-100 bg-indigo-50/50 p-4 flex items-center gap-3">
          <Loader2 size={16} className="animate-spin text-indigo-500" />
          <span className="text-sm text-indigo-700">
            ナレッジを検索して返信案を生成中…
          </span>
        </div>
      )}
      {rag.kind === 'preview' && (
        <div className="mb-3 rounded-lg border border-indigo-200 bg-indigo-50/50 p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-indigo-700 inline-flex items-center gap-1">
              <BookOpen size={14} /> 返信案 (参照ナレッジ付き)
            </span>
            <span className="text-[10px] text-gray-500">
              {rag.confidence != null &&
                `確信度 ${Math.round(rag.confidence * 100)}% · `}
              {rag.durationMs} ms
            </span>
          </div>

          {/* 人間確認推奨の警告 (低 confidence / needs_human / no_answer / 引用ゼロ) */}
          {(rag.needsHuman ||
            rag.noAnswer ||
            rag.citations.length === 0 ||
            (rag.confidence != null &&
              rag.confidence < rag.lowConfidenceThreshold)) && (
            <div className="mb-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-800 inline-flex items-start gap-1.5 w-full">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>
                ※自動生成、人間確認推奨
                {rag.noAnswer && '（ナレッジで十分に回答できませんでした）'}
                {!rag.noAnswer &&
                  rag.citations.length === 0 &&
                  '（参照ナレッジなし）'}
              </span>
            </div>
          )}

          <pre className="whitespace-pre-wrap text-sm text-gray-800 font-sans bg-white rounded-md border border-indigo-100 p-3 max-h-64 overflow-auto">
            {rag.draft}
          </pre>

          {/* 引用元 */}
          {rag.citations.length > 0 && (
            <div className="mt-2">
              <div className="text-[10px] font-semibold text-gray-500 tracking-wider mb-1">
                参照ナレッジ候補 ({rag.citations.length})
              </div>
              <ul className="space-y-1">
                {rag.citations.map((c) => (
                  <li
                    key={c.chunk_id}
                    className="rounded-md border border-indigo-100 bg-white px-2 py-1 text-[11px] text-gray-700 flex items-center justify-between gap-2"
                  >
                    <span className="inline-flex items-center gap-1 min-w-0">
                      <BookOpen size={11} className="shrink-0 text-indigo-400" />
                      <span className="truncate">
                        {c.title || '(タイトルなし)'}
                      </span>
                    </span>
                    <span className="shrink-0 text-[10px] text-gray-400">
                      {c.rrf_score != null &&
                        `score ${c.rrf_score.toFixed(3)} · `}
                      chunk {c.chunk_id.slice(0, 8)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap gap-2 mt-3">
            <button
              type="button"
              onClick={generateRag}
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
            >
              <RefreshCw size={12} /> 再生成
            </button>
            <button
              type="button"
              onClick={editRagDraft}
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
            >
              <Pencil size={12} /> 編集
            </button>
            <button
              type="button"
              onClick={adoptRagDraft}
              className="inline-flex items-center gap-1.5 rounded-md bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-600"
            >
              <Check size={12} /> 採用
            </button>
          </div>
        </div>
      )}
      {rag.kind === 'error' && (
        <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">
          返信案生成失敗: {rag.error}
          <button
            onClick={generateRag}
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
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={generateRag}
            disabled={rag.kind === 'loading'}
            title="ナレッジを検索し、引用元付きの返信案を生成します"
            className="inline-flex items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <BookOpen size={14} />
            {rag.kind === 'loading' ? '生成中…' : '返信案を生成'}
          </button>
        </div>

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
