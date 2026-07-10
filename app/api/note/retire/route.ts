import { NextRequest, NextResponse } from 'next/server';
import { retireNote } from '@/lib/embed/submit-note';
import { authorizeInternalApiRoute } from '@/lib/auth/api-auth';

/**
 * 現場ナレッジ メモ 候補の取下げプロキシ (POST)。
 *
 * 中身は submit-note.ts (retireNote) への委譲のみ。認可方針は `../route.ts` と同一
 * (`authorizeInternalApiRoute` によるサーバ間専用ゲート。ブラウザからは
 * `app/_actions/note.ts` の Server Action 経由でのみ到達する)。
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
  const candidateId = typeof (body as { candidateId?: unknown })?.candidateId === 'string'
    ? (body as { candidateId: string }).candidateId
    : '';
  if (!candidateId.trim()) {
    return NextResponse.json({ ok: false, error: 'candidateId is required' }, { status: 400 });
  }

  const r = await retireNote({ candidateId });
  if (!r.ok) {
    const status = r.reason === 'embed_key_unprovisioned' ? 503 : 502;
    return NextResponse.json({ ok: false, reason: r.reason }, { status });
  }
  return NextResponse.json({ ok: true });
}
