'use client';

/**
 * 現場ナレッジ メモ入力ウィジェット (全ページ右下常駐)。
 *
 * fetch 先は cs-manager 自身の `/api/note` (プロキシ) のみ。origin-ai を直叩きしない
 * (EMBED_CLIENT_KEY はブラウザに一切渡らない。鍵解決と転送はサーバ側 submit-note.ts が担う)。
 * 振り分け(unverified→confirmed の判定)は AI と管理者が origin-ai 側で行うため、
 * ここではテキストを送るだけの薄い UI に留める。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

interface SimilarItem {
  title: string;
  score: number;
}

interface NoteListItem {
  id: string;
  title: string;
  snippet: string;
  state: 'unverified' | 'confirmed';
  destination: string;
  created_at: string;
  entered_by: string;
}

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
    try {
      const res = await fetch('/api/note?limit=10', { cache: 'no-store' });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json || json.ok !== true) {
        setListError('一覧の取得に失敗しました');
        return;
      }
      setItems(Array.isArray(json.items) ? json.items : []);
    } catch {
      setListError('一覧の取得に失敗しました');
    } finally {
      setListLoading(false);
    }
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
    try {
      const res = await fetch('/api/note', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: trimmed,
          ...(rationale.trim() ? { rationale: rationale.trim() } : {}),
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json || json.ok !== true) {
        // エラーでも入力テキストは消さない (書き直し不要にする)。
        setSaveError('保存に失敗しました。時間をおいて再度お試しください。');
        return;
      }
      setText('');
      setRationale('');
      setSimilar(Array.isArray(json.similar) ? json.similar : []);
      void loadList();
    } catch {
      setSaveError('保存に失敗しました。時間をおいて再度お試しください。');
    } finally {
      setSaving(false);
    }
  }

  async function handleRetire(candidateId: string) {
    if (retiringId) return;
    setRetiringId(candidateId);
    try {
      const res = await fetch('/api/note/retire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidateId }),
      });
      const json = await res.json().catch(() => null);
      if (res.ok && json && json.ok === true) {
        setItems((prev) => prev.filter((it) => it.id !== candidateId));
      }
      // 失敗時は一覧を据え置く (非破壊)。次回開いた際に再取得すれば復帰できる。
    } catch {
      // no-op: 上記コメントの通り一覧は据え置く。
    } finally {
      setRetiringId(null);
    }
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

            {saveError && <p className="text-[12px] text-red-600">{saveError}</p>}

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
