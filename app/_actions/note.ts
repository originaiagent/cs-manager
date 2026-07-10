'use server';

import { internalFetch } from '@/lib/auth/internal-fetch';

/**
 * 現場ナレッジ メモ ウィジェット向け Server Action。
 *
 * cs-manager の正しい三段構成 (create-article.ts が手本):
 *   client (NoteWidget.tsx) → Server Action (本ファイル。middleware がユーザーセッションを認可) →
 *   internalFetch (内部鍵をサーバ側でのみ付与) → `/api/note*` (internal-key ゲート済み route)。
 * ブラウザから `/api/note*` へ直接 fetch する経路は無い (route 側で 401 に落ちる)。
 */

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
