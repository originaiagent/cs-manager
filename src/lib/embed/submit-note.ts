/**
 * 現場ナレッジ メモ 送信/一覧/取消 (cs-manager サーバ側・単一入口)。
 *
 * origin-ai embed facade のナレッジメモ口 (POST/GET /api/embed/knowledge,
 * POST /api/embed/knowledge/retire) を叩く唯一の関数群。契約(SoT)は origin-ai 側に定義され、
 * cs-manager はその endpoint/payload に準拠する薄い writer/reader を持つ (submit-feedback.ts /
 * run-oneshot.ts の写経・v1 pilot)。
 *
 * 不変条件 (submit-feedback.ts / run-oneshot.ts と同じ fail-closed / 鍵安全):
 *   - 認証 = per-tool embed key (X-Embed-Key)。EMBED_CLIENT_KEY は **サーバ側 env のみ**。
 *     レスポンス/ブラウザ/ログへ一切露出しない。鍵未配布 (key/baseUrl 未設定) → fail。
 *   - baseUrl/key の解決方法は submit-feedback.ts / run-oneshot.ts と同一
 *     (process.env.EMBED_CLIENT_KEY / process.env.ORIGIN_AI_BASE_URL)。新しい鍵解決を発明しない。
 *   - 各 HTTP リクエストは AbortSignal.timeout で個別に中断する (hung 接続対策、run-oneshot.ts と同様)。
 *   - エラーは安定ラベル (reason) のみ返す。stack / env / raw は出さない。
 */

// server-only 相当 (cf. submit-feedback.ts / run-oneshot.ts): クライアントへバンドルされたら即時 throw。
if (typeof window !== 'undefined') {
  throw new Error('submit-note.ts is server-only and must not be imported in the browser');
}

const REQUEST_TIMEOUT_MS = 15_000;

export interface NoteSimilarItem {
  title: string;
  score: number;
}

export interface SaveNoteResult {
  ok: boolean;
  /** 保存成功時の候補 id。 */
  candidateId?: string;
  /** 類似候補 (無ければ空配列)。 */
  similar?: NoteSimilarItem[];
  /** 保存直後の状態 (常に 'unverified' 想定)。 */
  state?: string;
  /** 失敗時の PII-safe 安定ラベル。 */
  reason?: string;
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

export interface ListNotesResult {
  ok: boolean;
  items?: NoteListItem[];
  reason?: string;
}

export interface RetireNoteResult {
  ok: boolean;
  reason?: string;
}

/** EMBED_CLIENT_KEY / ORIGIN_AI_BASE_URL の解決 (submit-feedback.ts / run-oneshot.ts と同じ方法)。 */
function resolveCredentials(): { key: string; baseUrl: string } | null {
  const key = process.env.EMBED_CLIENT_KEY?.replace(/\s+$/, '');
  const baseUrl = process.env.ORIGIN_AI_BASE_URL?.replace(/\s+$/, '').replace(/\/$/, '');
  if (!key || !baseUrl) return null;
  return { key, baseUrl };
}

/**
 * 現場ナレッジメモを origin-ai へ保存する。POST /api/embed/knowledge へ転送。
 * 200 → ok:true + candidateId/similar/state。それ以外 → ok:false + 安定ラベル。
 * 鍵未配布 (key/baseUrl 未設定) → fail-closed (embed_key_unprovisioned)。
 */
export async function saveNote(args: {
  text: string;
  rationale?: string | null;
}): Promise<SaveNoteResult> {
  const creds = resolveCredentials();
  if (!creds) return { ok: false, reason: 'embed_key_unprovisioned' };

  const text = typeof args.text === 'string' ? args.text.trim() : '';
  if (!text) return { ok: false, reason: 'missing_text' };
  const rationale =
    typeof args.rationale === 'string' && args.rationale.trim() ? args.rationale.trim() : undefined;

  let resp: Response;
  try {
    resp = await fetch(`${creds.baseUrl}/api/embed/knowledge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Embed-Key': creds.key },
      body: JSON.stringify({ text, ...(rationale ? { rationale } : {}) }),
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: 'note_save_request_failed' };
  }
  if (!resp.ok) {
    return { ok: false, reason: `note_save_${resp.status}` };
  }
  let json: unknown;
  try {
    json = await resp.json();
  } catch {
    return { ok: false, reason: 'note_save_invalid_response' };
  }
  const j = (json ?? {}) as {
    ok?: unknown;
    candidateId?: unknown;
    similar?: unknown;
    state?: unknown;
  };
  if (j.ok !== true) {
    return { ok: false, reason: 'note_save_rejected' };
  }
  return {
    ok: true,
    candidateId: typeof j.candidateId === 'string' ? j.candidateId : undefined,
    similar: Array.isArray(j.similar) ? (j.similar as NoteSimilarItem[]) : [],
    state: typeof j.state === 'string' ? j.state : undefined,
  };
}

/**
 * 直近の現場ナレッジメモ候補を取得する。GET /api/embed/knowledge?limit=<n> へ転送。
 * 200 → ok:true + items。それ以外 → ok:false + 安定ラベル。
 */
export async function listNotes(args: { limit?: number } = {}): Promise<ListNotesResult> {
  const creds = resolveCredentials();
  if (!creds) return { ok: false, reason: 'embed_key_unprovisioned' };

  const limit =
    Number.isFinite(args.limit) && (args.limit as number) > 0 ? Math.floor(args.limit as number) : 10;

  let resp: Response;
  try {
    resp = await fetch(`${creds.baseUrl}/api/embed/knowledge?limit=${limit}`, {
      headers: { 'X-Embed-Key': creds.key },
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: 'note_list_request_failed' };
  }
  if (!resp.ok) {
    return { ok: false, reason: `note_list_${resp.status}` };
  }
  let json: unknown;
  try {
    json = await resp.json();
  } catch {
    return { ok: false, reason: 'note_list_invalid_response' };
  }
  const items = (json as { items?: unknown })?.items;
  return { ok: true, items: Array.isArray(items) ? (items as NoteListItem[]) : [] };
}

/**
 * 現場ナレッジメモ候補を取り下げる。POST /api/embed/knowledge/retire へ転送。
 * 200 → ok:true。それ以外 → ok:false + 安定ラベル。
 */
export async function retireNote(args: { candidateId: string }): Promise<RetireNoteResult> {
  const creds = resolveCredentials();
  if (!creds) return { ok: false, reason: 'embed_key_unprovisioned' };

  const candidateId = typeof args.candidateId === 'string' ? args.candidateId.trim() : '';
  if (!candidateId) return { ok: false, reason: 'missing_candidate_id' };

  let resp: Response;
  try {
    resp = await fetch(`${creds.baseUrl}/api/embed/knowledge/retire`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Embed-Key': creds.key },
      body: JSON.stringify({ candidateId }),
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: 'note_retire_request_failed' };
  }
  if (!resp.ok) {
    return { ok: false, reason: `note_retire_${resp.status}` };
  }
  let json: unknown;
  try {
    json = await resp.json();
  } catch {
    return { ok: false, reason: 'note_retire_invalid_response' };
  }
  if ((json as { ok?: unknown })?.ok !== true) {
    return { ok: false, reason: 'note_retire_rejected' };
  }
  return { ok: true };
}
