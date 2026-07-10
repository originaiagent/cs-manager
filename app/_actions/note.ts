'use server';

import { cookies } from 'next/headers';
import { internalFetch } from '@/lib/auth/internal-fetch';
import { isCoreAuthEnabled, TOOL_KEY } from '@/lib/auth/core-auth-config';
import { verifyCoreAccessToken, extractAccessToken, sessionCookieName } from '@/lib/auth/core-oidc-edge';

/**
 * 現場ナレッジ メモ ウィジェット向け Server Action。
 *
 * cs-manager の正しい三段構成 (create-article.ts が手本):
 *   client (NoteWidget.tsx) → Server Action (本ファイル。middleware がユーザーセッションを認可) →
 *   internalFetch (内部鍵をサーバ側でのみ付与) → `/api/note*` (internal-key ゲート済み route)。
 * ブラウザから `/api/note*` へ直接 fetch する経路は無い (route 側で 401 に落ちる)。
 *
 * 多層防御 (codex 指摘対応): middleware の認可は「現在ページの path」単位で効くため、
 * NoteWidget はルートレイアウト常駐で `/login` (PUBLIC_PATHS = 認証免除) にも描画される。
 * `/login` 上で本 Server Action を実行すると middleware のユーザーセッション検証を経由しない
 * (path 起因のバイパス)。internal-key ゲートは cs-manager サーバ内部の呼び出し元検証であり
 * このバイパスは止められないため、特権 (origin-ai embed 鍵) を伴う本 action 自身の先頭で
 * ユーザーセッションを明示検証する (assertUser。path に依存しない fail-closed)。
 */

/**
 * Server Action 内ユーザーセッション検証。
 *
 * `isCoreAuthEnabled()===false` (既定) の間はアプリ全体が匿名運用のため現行動作を維持し素通り
 * (退行なし)。`true` の場合は session cookie を Core JWKS で検証し、
 * `tool_access['cs-manager']===true` を要求する (middleware.ts と同一ロジック)。
 * 未ログイン/検証失敗/tool_access 無し → throw (呼び出し元 client の runAction() が
 * authExpired として捕捉し、再ログイン導線へ誘導する)。
 */
async function assertUser(): Promise<void> {
  if (!isCoreAuthEnabled()) return;
  const token = extractAccessToken(cookies().get(sessionCookieName())?.value);
  if (!token) throw new Error('unauthorized');
  const user = await verifyCoreAccessToken(token);
  if (user.toolAccess?.[TOOL_KEY] !== true) throw new Error('forbidden');
}

export interface NoteSimilarItem {
  title: string;
  score: number;
}

export interface SaveNoteActionResult {
  ok: boolean;
  candidateId?: string;
  similar?: NoteSimilarItem[];
  state?: string;
  error?: string;
}

export interface NoteListItem {
  id: string;
  title: string;
  snippet: string;
  state: 'unverified' | 'confirmed';
  destination: string;
  created_at: string;
  entered_by: string;
}

export interface ListNotesActionResult {
  ok: boolean;
  items?: NoteListItem[];
  error?: string;
}

export interface RetireNoteActionResult {
  ok: boolean;
  error?: string;
}

export async function saveNoteAction(args: {
  text: string;
  rationale?: string;
}): Promise<SaveNoteActionResult> {
  await assertUser();
  try {
    const res = await internalFetch('/api/note', {
      method: 'POST',
      body: JSON.stringify({
        text: args.text,
        ...(args.rationale && args.rationale.trim() ? { rationale: args.rationale.trim() } : {}),
      }),
    });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || j.ok !== true) {
      return {
        ok: false,
        error:
          (typeof j.reason === 'string' && j.reason) ||
          (typeof j.error === 'string' && j.error) ||
          `save failed: ${res.status}`,
      };
    }
    return {
      ok: true,
      candidateId: typeof j.candidateId === 'string' ? j.candidateId : undefined,
      similar: Array.isArray(j.similar) ? (j.similar as NoteSimilarItem[]) : [],
      state: typeof j.state === 'string' ? j.state : undefined,
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `network error: ${msg}` };
  }
}

export async function listNotesAction(limit?: number): Promise<ListNotesActionResult> {
  await assertUser();
  try {
    const n = Number.isFinite(limit) && (limit as number) > 0 ? Math.floor(limit as number) : 10;
    const res = await internalFetch(`/api/note?limit=${n}`, { method: 'GET' });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || j.ok !== true) {
      return {
        ok: false,
        error: (typeof j.reason === 'string' && j.reason) || `list failed: ${res.status}`,
      };
    }
    return { ok: true, items: Array.isArray(j.items) ? (j.items as NoteListItem[]) : [] };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `network error: ${msg}` };
  }
}

export async function retireNoteAction(candidateId: string): Promise<RetireNoteActionResult> {
  await assertUser();
  if (typeof candidateId !== 'string' || !candidateId.trim()) {
    return { ok: false, error: 'missing_candidate_id' };
  }
  try {
    const res = await internalFetch('/api/note/retire', {
      method: 'POST',
      body: JSON.stringify({ candidateId: candidateId.trim() }),
    });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || j.ok !== true) {
      return {
        ok: false,
        error: (typeof j.reason === 'string' && j.reason) || `retire failed: ${res.status}`,
      };
    }
    return { ok: true };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `network error: ${msg}` };
  }
}
