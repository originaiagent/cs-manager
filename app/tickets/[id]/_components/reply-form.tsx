'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Save,
  Loader2,
  RefreshCw,
  Pencil,
  Check,
  BookOpen,
  AlertTriangle,
  Lock,
  Info,
  ExternalLink,
} from 'lucide-react';
import {
  generateRagDraft,
  type RagCitation,
  type GroundingArticle,
} from '../_actions/generate-rag-draft';
import { saveDraft } from '../_actions/save-draft';
import {
  AUTH_EXPIRED_MESSAGE,
  loginHrefForHere,
  runAction,
} from '@/lib/client/auth-recovery';
import KnowledgeMetaPopover from './knowledge-meta-popover';
import NotThisButton from './not-this-button';

interface Props {
  ticketId: string;
  initialBody: string;
  initialSource: string | null;
  /**
   * 旧形式 (AI 由来かつ未分離 = 混在の可能性) のドラフトが存在する。
   * true の場合 textarea には何も入れず、再生成を促す通知のみ表示する。
   */
  legacyUnsafe?: boolean;
  /** 製品情報の有無 (page.tsx から渡される。現状は表示制御に未使用だが互換のため受領) */
  productAvailable?: boolean;
}

type RagState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | {
      kind: 'preview';
      /** origin-ai run識別子 (= ai_embed_runs.id)。〔これじゃない〕紐付け用 (無い場合 null)。 */
      runId: string | null;
      /** 顧客向け本文のみ (split-reply 分離後)。parseOk=false 時は ''。 */
      draft: string;
      /** 社内用プレビュー (読み取り専用)。送信欄には入れない。 */
      internalPreview: string;
      /** 構造分離に成功したか。false = 採用/編集不可 (送信欄空)。 */
      parseOk: boolean;
      /**
       * AI が回答不能でエスカレーション(人間対応)を要求したか。Bug1 根治:
       * 「分離失敗エラー」とは別状態。true のときは赤エラーでなく人間対応案内+理由を表示し、
       * 採用/編集は無効(draft の有無に関わらず自動採用しない)。
       */
      escalated: boolean;
      /** 社内枠「関連ナレッジ候補」(読み取り専用表示)。送信/保存しない。 */
      groundingArticles: GroundingArticle[];
      /** 社内枠「AI の参照メモ」(marker 除去済み)。送信/保存しない。 */
      internalGroundingText: string;
      /** 社内枠「対応メモ」(marker 除去済み)。送信/保存しない。 */
      internalNotesText: string;
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
  | { kind: 'error'; error: string; authExpired?: boolean };

/** 低 confidence 警告の既定閾値 (サーバ rag_config 未取得時のみのフォールバック) */
const DEFAULT_LOW_CONFIDENCE_THRESHOLD = 0.5;

/**
 * 対応メモ文字列を箇条書き行に整形する。
 * - 行ごとに分割し空行を除去。
 * - 先頭の箇条書き記号 (・/-/*) と続く空白を 1 つ除去 (二重マーカー防止)。
 * マーカー/ナレーションの解釈はしない (構造化済み NOTES 中身のみ受け取る)。
 */
function toBullets(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*[・\-*]\s*/, '').trim())
    .filter((l) => l.length > 0);
}

export default function ReplyForm({
  ticketId,
  initialBody,
  initialSource,
  legacyUnsafe = false,
}: Props) {
  const router = useRouter();
  const [body, setBody] = useState(initialBody);
  const [source, setSource] = useState<string | null>(initialSource);
  const [savingManual, setSavingManual] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [rag, setRag] = useState<RagState>({ kind: 'idle' });
  // 社内枠 Info ポップオーバーで開いている記事 (read-only 表示用)。
  const [openArticle, setOpenArticle] = useState<GroundingArticle | null>(null);
  const [, startTransition] = useTransition();

  async function saveManual() {
    if (!body.trim() || savingManual) return;
    setSavingManual(true);
    setSaveError(null);
    try {
      const r = await runAction(() => saveDraft(ticketId, body, 'manual'));
      if (r.authExpired) {
        setSaveError(AUTH_EXPIRED_MESSAGE);
        return;
      }
      if (!r.result.ok) {
        throw new Error(r.result.error ?? 'save failed');
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
    // 認証切れ (middleware が action を 401/403 で弾く) は throw / 戻り値なしになるため、
    // runAction で捕捉して loading を解除し再ログイン導線を出す (無限ローディング固着の防止)。
    const r = await runAction(() => generateRagDraft(ticketId));
    if (r.authExpired) {
      setRag({ kind: 'error', error: AUTH_EXPIRED_MESSAGE, authExpired: true });
      return;
    }
    const result = r.result;
    if (!result.ok || typeof result.draft !== 'string') {
      setRag({ kind: 'error', error: result.error ?? 'unknown error' });
      return;
    }
    setRag({
      kind: 'preview',
      runId: result.runId ?? null,
      draft: result.draft,
      internalPreview: result.internalPreview ?? '',
      parseOk: result.parseOk === true,
      escalated: result.escalated === true,
      groundingArticles: result.groundingArticles ?? [],
      internalGroundingText: result.internalGroundingText ?? '',
      internalNotesText: result.internalNotesText ?? '',
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
    // fail-closed: 分離失敗 / 顧客本文空 / エスカレーション(人間対応要求)時は採用させない。
    if (!rag.parseOk || !rag.draft.trim() || rag.escalated) return;
    setBody(rag.draft);
    setSource('ai_draft');
    const adopted = rag.draft;
    setRag({ kind: 'idle' });
    // 採用 = source='ai_draft' で、顧客向け本文のみを is_separated=true で永続化。
    try {
      const r = await runAction(() =>
        saveDraft(ticketId, adopted, 'ai_draft', { is_separated: true }),
      );
      if (r.authExpired) {
        setSaveError(AUTH_EXPIRED_MESSAGE);
        return;
      }
      if (!r.result.ok) {
        setSaveError(r.result.error ?? '保存に失敗しました');
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
    // 分離失敗 / エスカレーション時は textarea に入れない (混在テキスト・未確認案の混入防止)。
    if (!rag.parseOk || !rag.draft.trim() || rag.escalated) return;
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
              <BookOpen size={14} /> 返信案 (ナレッジ参照 AI)
            </span>
            <span className="text-[10px] text-gray-500">
              {rag.confidence != null &&
                `確信度 ${Math.round(rag.confidence * 100)}% · `}
              {rag.durationMs} ms
            </span>
          </div>

          {/* 人間確認推奨の警告 (常時、自動生成のため)。
              方式A ではナレッジ検索は AI agent 内で行われ cs 側に引用が返らないため、
              「参照ナレッジなし」=引用ゼロ判定は使わない (誤警告防止)。 */}
          <div className="mb-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-800 inline-flex items-start gap-1.5 w-full">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>
              ※自動生成、送信前に人間確認を推奨します
              {rag.noAnswer && '（ナレッジで十分に回答できませんでした）'}
            </span>
          </div>

          {/* エスカレーション (AI 回答不能 → 人間対応): Bug1 根治。
              正当な「回答できない」を分離失敗エラーと区別し、理由付きで人間対応を促す。 */}
          {rag.escalated && (
            <div
              className="mb-2 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-[12px] text-amber-900 flex items-start gap-1.5"
              data-testid="rag-escalated"
            >
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>
                AIはこの問い合わせに自動で回答できませんでした（人間対応が必要です）。
                {rag.internalNotesText.trim() && (
                  <>
                    {' '}
                    理由：
                    <span className="font-medium">
                      {rag.internalNotesText.trim()}
                    </span>
                  </>
                )}
                <br />
                下の返信欄にご担当者が返信を入力して保存してください。
              </span>
            </div>
          )}

          {/* 分離失敗 (fail-closed・稀): エスカレーションでない真の安全失敗のみ。 */}
          {!rag.parseOk && !rag.escalated && (
            <div className="mb-2 rounded-md border border-rose-300 bg-rose-50 p-2.5 text-[12px] text-rose-800 flex items-start gap-1.5">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>
                自動分離に失敗しました。下の社内用テキストから顧客向け部分を手動で切り出して入力してください。
                （安全のため送信欄・採用は無効化しています）
              </span>
            </div>
          )}

          {/* 顧客向け本文プレビュー (parseOk かつ非エスカレーション時のみ。送信される唯一のテキスト)。 */}
          {rag.parseOk && !rag.escalated && (
            <>
              <div className="text-[10px] font-semibold text-indigo-700 tracking-wider mb-1">
                顧客向け返信 (この内容のみ送信されます)
              </div>
              <pre className="whitespace-pre-wrap text-sm text-gray-800 font-sans bg-white rounded-md border border-indigo-100 p-3 max-h-64 overflow-auto">
                {rag.draft}
              </pre>
            </>
          )}

          {/* エスカレーションだが下書き本文も返ってきた異常/混合ケース: 参考として read-only 表示。
              自動採用はさせない (人間確認前提)。 */}
          {rag.escalated && rag.draft.trim() && (
            <>
              <div className="text-[10px] font-semibold text-amber-700 tracking-wider mb-1">
                参考: AI下書き（自動採用不可・要人間確認）
              </div>
              <pre className="whitespace-pre-wrap text-sm text-gray-700 font-sans bg-white rounded-md border border-amber-100 p-3 max-h-64 overflow-auto select-text">
                {rag.draft}
              </pre>
            </>
          )}

          {/* 〔これじゃない〕: この下書きを生成した origin-ai run に紐づけてフィードバック送信。
              parseOk に関わらず run は実行されているので表示する (run識別子がある時のみ)。 */}
          {rag.runId && (
            <div
              className="mt-2 flex items-center gap-2"
              data-testid="reply-not-this"
            >
              <span className="text-[11px] text-gray-400">
                この返信案はどうですか？
              </span>
              <NotThisButton runId={rag.runId} />
            </div>
          )}

          {/* 社内用パネル (読み取り専用、絶対に送信されない)。
              parseOk=true: 構造化表示 (関連ナレッジ候補 / 対応メモ)。マーカー/ナレーション非表示。
              parseOk=false: fail-closed の稀な経路。オペレータが手動切り出しできるよう raw 全文を表示。 */}
          {rag.parseOk || rag.escalated ? (
            <div className="mt-2 space-y-3">
              <div className="text-[10px] font-semibold text-gray-500 tracking-wider inline-flex items-center gap-1">
                <Lock size={11} className="text-gray-400" />
                社内用・送信されません
              </div>

              {/* 関連ナレッジ候補 (行 = 日本語タイトル + Info + リンク)。
                  方式1 再検索のため「候補」であり「AI が実際に使った記事」ではない旨を明示。 */}
              {rag.groundingArticles.length > 0 && (
                <div>
                  <div className="text-[10px] font-semibold text-gray-500 tracking-wider mb-1">
                    関連ナレッジ候補（送信されません）
                  </div>
                  <ul className="space-y-1">
                    {rag.groundingArticles.map((art) => (
                      <li
                        key={art.id}
                        className="rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5 text-[12px] text-gray-700 flex items-center justify-between gap-2"
                      >
                        <span className="inline-flex items-center gap-1.5 min-w-0">
                          <BookOpen
                            size={12}
                            className="shrink-0 text-gray-400"
                          />
                          <span className="truncate">
                            {art.title?.trim() || '(タイトルなし)'}
                          </span>
                        </span>
                        <span className="shrink-0 inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => setOpenArticle(art)}
                            aria-label="記事の詳細を表示"
                            title="記事の詳細を表示"
                            className="rounded p-0.5 text-gray-400 hover:bg-gray-200 hover:text-gray-700"
                          >
                            <Info size={14} />
                          </button>
                          <Link
                            href={`/knowledge/${art.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label="ナレッジ詳細を開く"
                            title="ナレッジ詳細を開く"
                            className="rounded p-0.5 text-gray-400 hover:bg-gray-200 hover:text-gray-700"
                          >
                            <ExternalLink size={14} />
                          </Link>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* 対応メモ (NOTES ブロックを箇条書き)。エスカレーション時は理由を上の案内で
                  既に表示しているため、ここでは重複表示しない。 */}
              {!rag.escalated && rag.internalNotesText.trim() && (
                <div>
                  <div className="text-[10px] font-semibold text-gray-500 tracking-wider mb-1">
                    対応メモ（送信されません）
                  </div>
                  <ul className="list-disc pl-5 space-y-0.5 text-[12px] text-gray-700">
                    {toBullets(rag.internalNotesText).map((line, i) => (
                      <li key={i} className="whitespace-pre-wrap">
                        {line}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* AI の参照メモ (GROUNDING の marker 除去済み prose、任意・muted)。 */}
              {rag.internalGroundingText.trim() && (
                <div>
                  <div className="text-[10px] font-semibold text-gray-400 tracking-wider mb-1">
                    AIの参照メモ（送信されません）
                  </div>
                  <p className="text-[11px] text-gray-500 whitespace-pre-wrap">
                    {rag.internalGroundingText}
                  </p>
                </div>
              )}
            </div>
          ) : (
            // fail-closed の稀な経路: 構造化できないため raw 全文を提示 (手動切り出し用)。
            rag.internalPreview.trim() && (
              <div className="mt-2">
                <div className="text-[10px] font-semibold text-gray-500 tracking-wider mb-1 inline-flex items-center gap-1">
                  <Lock size={11} className="text-gray-400" />
                  社内用・送信されません（自動分離に失敗したため全文表示）
                </div>
                <pre className="whitespace-pre-wrap text-[12px] text-gray-600 font-sans bg-gray-50 rounded-md border border-gray-200 p-3 max-h-48 overflow-auto select-text">
                  {rag.internalPreview}
                </pre>
              </div>
            )
          )}

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
              disabled={!rag.parseOk || !rag.draft.trim() || rag.escalated}
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Pencil size={12} /> 編集
            </button>
            <button
              type="button"
              onClick={adoptRagDraft}
              disabled={!rag.parseOk || !rag.draft.trim() || rag.escalated}
              title={
                rag.escalated
                  ? 'AIが回答できなかったため採用できません（人間対応してください）'
                  : !rag.parseOk
                    ? '自動分離に失敗したため採用できません'
                    : undefined
              }
              className="inline-flex items-center gap-1.5 rounded-md bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Check size={12} /> 採用
            </button>
          </div>
        </div>
      )}
      {rag.kind === 'error' && (
        <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">
          返信案生成失敗: {rag.error}
          {rag.authExpired ? (
            <Link
              href={loginHrefForHere()}
              className="ml-2 underline hover:no-underline font-medium"
            >
              再ログイン
            </Link>
          ) : (
            <button
              onClick={generateRag}
              className="ml-2 underline hover:no-underline"
            >
              再試行
            </button>
          )}
        </div>
      )}

      {/* 旧形式 (AI 由来かつ未分離 = 混在の可能性) のドラフトが存在する場合の通知。
          textarea には入れない (社内テキストが送信欄に混入しない構造保証)。 */}
      {legacyUnsafe && (
        <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 flex items-start gap-1.5">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            旧形式の下書きが存在します（混在のため送信欄には入れていません）。再生成してください。
          </span>
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
            <span className="text-[11px] text-rose-600">
              {saveError}
              {saveError === AUTH_EXPIRED_MESSAGE && (
                <Link
                  href={loginHrefForHere()}
                  className="ml-1.5 underline hover:no-underline font-medium"
                >
                  再ログイン
                </Link>
              )}
            </span>
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

      {/* 社内枠 Info ポップオーバー (read-only、渡されたメタのみ表示)。 */}
      {openArticle && (
        <KnowledgeMetaPopover
          id={openArticle.id}
          title={openArticle.title}
          question={openArticle.question}
          answer={openArticle.answer}
          status={openArticle.status}
          onClose={() => setOpenArticle(null)}
        />
      )}
    </div>
  );
}
