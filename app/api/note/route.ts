import { NextRequest, NextResponse } from 'next/server';
import { saveNote, listNotes } from '@/lib/embed/submit-note';

/**
 * 現場ナレッジ メモ ウィジェット向けプロキシ (POST=保存 / GET=一覧)。
 *
 * 中身は submit-note.ts への委譲のみ (endpoint/payload/reason 正規化は同ファイルが SoT)。
 * origin-ai の EMBED_CLIENT_KEY はここでも submit-note.ts 内でもブラウザへ一切露出しない。
 *
 * 認可について (pilot・要レビュー):
 *   cs-manager の他の /api/* (書込/読取 API) は `authorizeInternalApiRoute` (X-Internal-API-Key)
 *   で「ブラウザ直叩き不可・Server Action 経由のみ」を担保しているが、本ウィジェットは
 *   NoteWidget.tsx (client component) から直接この route へ fetch する要件のため、同ゲートを
 *   適用すると常に 401 になり機能しない。そのため本 route は意図的に internal-key 認可を
 *   **付けていない**（cs-manager ユーザー認証 middleware も `/api/*` を対象外にしているため、
 *   現状はログイン有無に関わらず到達可能）。pilot 版の暫定判断であり、本番展開前に
 *   セッション/レート制限等での保護要否を判断すること (report 参照)。
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
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
