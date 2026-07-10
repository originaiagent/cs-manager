'use client';

/**
 * 現場ナレッジ メモ入力ウィジェット (全ページ右下常駐)。
 *
 * 送信経路は cs-manager の正しい三段構成 (create-article.ts が手本):
 *   本コンポーネント(client) → Server Action (`@/app/_actions/note`。middleware がユーザー
 *   セッションを認可) → internalFetch (内部鍵をサーバ側でのみ付与) → `/api/note*`
 *   (internal-key ゲート済み route)。origin-ai を直叩きしない (EMBED_CLIENT_KEY はブラウザに
 *   一切渡らない)。振り分け(unverified→confirmed の判定)は AI と管理者が origin-ai 側で行うため、
 *   ここではテキストを送るだけの薄い UI に留める。
 *
 * 認証切れ復帰: 既存の auth-recovery (`runAction`) を踏襲し、Server Action が認証切れ/未ログイン
 * (assertUser の throw 含む) で到達しなかった場合は authExpired として捕捉する (無限ローディング防止)。
 * 本ウィジェットはルートレイアウト常駐で `/login` にも描画されるため、Server Action 側
 * (`@/app/_actions/note` の assertUser) が path に依存せずユーザーセッションを検証する。
 * 保存 (handleSave) は入力中の本文を保持するフォームのため、認証切れ時も強制遷移せず
 * エラー表示 + 再ログイン Link に留める (record-form.tsx / article-form.tsx と同じ規約。
 * データ保全優先 = src/lib/client/auth-recovery.ts のコメント方針)。取下げ (handleRetire) は
 * 入力を持たないため not-this-button.tsx と同じ即時遷移のままで良い。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  saveNoteAction,
  listNotesAction,
  retireNoteAction,
  type NoteSimilarItem as SimilarItem,
  type NoteListItem,
} from '@/app/_actions/note';
import { runAction, AUTH_EXPIRED_MESSAGE, loginHrefForHere } from '@/lib/client/auth-recovery';

const STATE_LABEL: Record<string, string> = {
  unverified: '🟡 未確認',
  confirmed: '🟢 確認済',
};

export default function NoteWidget() {
  const [open, setOpen] = useState(false);

  const [text, setText] = useState('');
  const [rationale, setRationale] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [similar, setSimilar] = useState<SimilarItem[] | null>(null);

  const [items, setItems] = useState<NoteListItem[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [retiringId, setRetiringId] = useState<string | null>(null);

  const loadedOnceRef = useRef(false);

  const loadList = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    const r = await runAction(() => listNotesAction(10));
    if (r.authExpired) {
      // 背景読み込みでの認証切れは、入力中の可能性があるため強制遷移はしない
      // (エラー表示のみに留め、書き直し不要にする)。
      setListError(AUTH_EXPIRED_MESSAGE);
      setListLoading(false);
      return;
    }
    if (!r.result.ok) {
      setListError('一覧の取得に失敗しました');
      setListLoading(false);
      return;
    }
    setItems(r.result.items ?? []);
    setListLoading(false);
  }, []);

  useEffect(() => {
    if (open && !loadedOnceRef.current) {
      loadedOnceRef.current = true;
      void loadList();
    }
  }, [open, loadList]);

  async function handleSave() {
    const trimmed = text.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setSaveError(null);
    setSimilar(null);
    const r = await runAction(() =>
      saveNoteAction({ text: trimmed, ...(rationale.trim() ? { rationale: rationale.trim() } : {}) }),
    );
    if (r.authExpired) {
      // 保存フォームは入力中の本文を持つため強制遷移しない (record-form.tsx / article-form.tsx
      // と同じ規約: エラー表示 + 再ログイン Link に留め、データ保全を優先する)。
      setSaveError(AUTH_EXPIRED_MESSAGE);
      setSaving(false);
      return;
    }
    if (!r.result.ok) {
      // エラーでも入力テキストは消さない (書き直し不要にする)。
      setSaveError('保存に失敗しました。時間をおいて再度お試しください。');
      setSaving(false);
      return;
    }
    setText('');
    setRationale('');
    setSimilar(r.result.similar ?? []);
    setSaving(false);
    void loadList();
  }

  async function handleRetire(candidateId: string) {
    if (retiringId) return;
    setRetiringId(candidateId);
    const r = await runAction(() => retireNoteAction(candidateId));
    if (r.authExpired) {
      if (typeof window !== 'undefined') {
        window.location.href = loginHrefForHere();
      }
      setRetiringId(null);
      return;
    }
    if (r.result.ok) {
      setItems((prev) => prev.filter((it) => it.id !== candidateId));
    }
    // 失敗時は一覧を据え置く (非破壊)。次回開いた際に再取得すれば復帰できる。
    setRetiringId(null);
  }

  return (
    <div className="fixed bottom-5 right-5 z-50">
      {open && (
        <div className="mb-3 w-[340px] max-w-[90vw] rounded-xl border border-gray-200 bg-white shadow-xl">
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
            <h3 className="text-sm font-semibold text-gray-900">現場ナレッジ メモ</h3>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="閉じる"
              className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
            >
              ✕
            </button>
          </div>

          <div className="space-y-2 px-4 py-3">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="気づいたこと・知識・ルールを書くだけ。振り分けはAIと管理者がやります"
              rows={4}
              className="w-full resize-none rounded-md border border-gray-200 px-2.5 py-2 text-[13px] text-gray-800 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none"
            />

            <details className="text-[12px] text-gray-500">
              <summary className="cursor-pointer select-none">根拠・出典(任意)</summary>
              <textarea
                value={rationale}
                onChange={(e) => setRationale(e.target.value)}
                placeholder="根拠や出典があれば"
                rows={2}
                className="mt-1.5 w-full resize-none rounded-md border border-gray-200 px-2.5 py-1.5 text-[12px] text-gray-800 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none"
              />
            </details>

            {saveError && (
              <p className="text-[12px] text-red-600">
                {saveError}
                {saveError === AUTH_EXPIRED_MESSAGE && (
                  <Link
                    href={loginHrefForHere()}
                    className="ml-1.5 underline hover:no-underline font-medium"
                  >
                    再ログイン
                  </Link>
                )}
              </p>
            )}

            <button
              type="button"
              onClick={handleSave}
              disabled={!text.trim() || saving}
              className="w-full rounded-md bg-brand-600 px-3 py-2 text-[13px] font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              {saving ? '保存中…' : '保存'}
            </button>

            {similar && similar.length > 0 && (
              <div className="rounded-md bg-amber-50 px-2.5 py-2 text-[12px] text-amber-800">
                💡 似た内容が既にあります
                <ul className="mt-1 list-disc pl-4">
                  {similar.slice(0, 3).map((s, i) => (
                    <li key={i} className="truncate">
                      {s.title}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="border-t border-gray-100 px-4 py-3">
            <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-gray-400">
              最近入ったもの
            </p>
            {listLoading && <p className="text-[12px] text-gray-400">読み込み中…</p>}
            {listError && <p className="text-[12px] text-red-500">{listError}</p>}
            {!listLoading && !listError && items.length === 0 && (
              <p className="text-[12px] text-gray-400">まだありません</p>
            )}
            <ul className="max-h-40 space-y-1.5 overflow-auto">
              {items.map((it) => (
                <li key={it.id} className="flex items-start justify-between gap-2 text-[12px]">
                  <span className="min-w-0 flex-1 break-words text-gray-700">
                    <span className="mr-1">{STATE_LABEL[it.state] ?? it.state}</span>
                    {it.title?.trim() || it.snippet?.trim() || '(内容なし)'}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleRetire(it.id)}
                    disabled={retiringId === it.id}
                    className="shrink-0 text-gray-400 hover:text-red-600 disabled:opacity-50"
                  >
                    下ろす
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="現場ナレッジメモを開く"
        className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-600 text-xl text-white shadow-lg hover:bg-brand-700"
      >
        📝
      </button>
    </div>
  );
}
