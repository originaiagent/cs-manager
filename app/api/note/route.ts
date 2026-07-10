import { NextRequest, NextResponse } from 'next/server';
import { saveNote, listNotes } from '@/lib/embed/submit-note';
import { authorizeInternalApiRoute } from '@/lib/auth/api-auth';

/**
 * 現場ナレッジ メモ ウィジェット向けプロキシ (POST=保存 / GET=一覧)。
 *
 * 中身は submit-note.ts への委譲のみ (endpoint/payload/reason 正規化は同ファイルが SoT)。
 * origin-ai の EMBED_CLIENT_KEY はここでも submit-note.ts 内でもブラウザへ一切露出しない。
 *
 * 認可 (cs-manager の他の書込/読取 /api/* と同型・customer-records/route.ts が手本):
 *   `authorizeInternalApiRoute` (X-Internal-API-Key) でサーバ間専用にし、ブラウザ直叩きを 401 で
 *   遮断する。ブラウザからの唯一の到達経路は Server Action (`app/_actions/note.ts`) →
 *   `internalFetch` (内部鍵をサーバ側でのみ付与) のみ。Server Action は middleware がユーザー
 *   セッションを認可するため、ログイン済み cs-manager ユーザーのみが実行できる。
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const authError = await authorizeInternalApiRoute(req);
  if (authError) return authError;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }
  const b = (body ?? {}) as { text?: unknown; rationale?: unknown };
  const text = typeof b.text === 'string' ? b.text : '';
  if (!text.trim()) {
    return NextResponse.json({ ok: false, error: 'text is required' }, { status: 400 });
  }
  const rationale = typeof b.rationale === 'string' ? b.rationale : undefined;

  const r = await saveNote({ text, rationale });
  if (!r.ok) {
    const status = r.reason === 'embed_key_unprovisioned' ? 503 : 502;
    return NextResponse.json({ ok: false, reason: r.reason }, { status });
  }
  return NextResponse.json({
    ok: true,
    candidateId: r.candidateId,
    similar: r.similar ?? [],
    state: r.state ?? 'unverified',
  });
}

export async function GET(req: NextRequest) {
  const authError = await authorizeInternalApiRoute(req);
  if (authError) return authError;

  const sp = req.nextUrl.searchParams;
  const limitRaw = Number(sp.get('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 10;

  const r = await listNotes({ limit });
  if (!r.ok) {
    const status = r.reason === 'embed_key_unprovisioned' ? 503 : 502;
    return NextResponse.json({ ok: false, reason: r.reason }, { status });
  }
  return NextResponse.json({ ok: true, items: r.items ?? [] });
}
