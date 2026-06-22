import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import { authorizeApiRoute } from '@/lib/auth/api-auth';
import { isCustomerSafeBody } from '@/lib/rag/split-reply';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 汎用 /drafts POST が許す source。`first_response` は **含めない** (codex CONCERN#1):
// テンプレ生成は orchestrator 専用 (直接 insert) とし、汎用 API から
// is_separated を立てずに送信安全扱いされる迂回を防ぐ。
const ALLOWED_SOURCES = ['manual', 'ai_draft', 'rag'] as const;

// AI 由来 source は「構造分離した顧客向け本文のみ」を保存する契約 → is_separated=true 必須。
const SEPARATION_REQUIRED_SOURCES = ['ai_draft', 'rag'] as const;

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const authError = authorizeApiRoute(req, { tier: 'internal' });
  if (authError) return authError;
  const sb = await getSupabaseAdmin();
  const { data, error } = await sb
    .from('ticket_drafts')
    .select('id, body, source, is_separated, created_at, updated_at')
    .eq('ticket_id', params.id)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // 送信安全ゲート: 最新行が AI 由来 (ai_draft/rag) かつ未分離 (is_separated=false) の
  // 旧形式 (混在の可能性) は、body をそのまま返さない (社内テキスト漏洩防止)。
  // body を空にし legacyUnsafe フラグを立てて返す → UI は再生成を促す。
  if (
    data &&
    (data.source === 'ai_draft' || data.source === 'rag') &&
    data.is_separated === false
  ) {
    return NextResponse.json({
      ok: true,
      draft: { ...data, body: '', legacyUnsafe: true },
    });
  }

  return NextResponse.json({ ok: true, draft: data });
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const authError = authorizeApiRoute(req, { tier: 'internal' });
  if (authError) return authError;
  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const body = payload?.body;
  const source = payload?.source ?? 'manual';
  if (typeof body !== 'string' || !body.trim()) {
    return NextResponse.json({ error: 'body is required' }, { status: 400 });
  }
  if (!ALLOWED_SOURCES.includes(source)) {
    return NextResponse.json(
      { error: `source must be one of ${ALLOWED_SOURCES.join(', ')}` },
      { status: 400 },
    );
  }

  // is_separated: 任意の boolean。manual はテンプレ/オペレータ入力なので既定 false。
  // AI 由来 (ai_draft/rag) は「split-reply で分離した顧客向け本文のみ」を保存する契約のため
  // is_separated=true を **必須** にする (parser 迂回で混在 body を送信安全扱いするのを防ぐ)。
  const rawIsSeparated = payload?.is_separated;
  if (rawIsSeparated !== undefined && typeof rawIsSeparated !== 'boolean') {
    return NextResponse.json(
      { error: 'is_separated must be a boolean' },
      { status: 400 },
    );
  }
  const isSeparated = rawIsSeparated === true;
  if (
    SEPARATION_REQUIRED_SOURCES.includes(source) &&
    !isSeparated
  ) {
    return NextResponse.json(
      {
        error: `source '${source}' requires is_separated=true (customer-only text)`,
      },
      { status: 400 },
    );
  }

  // サーバ側送信安全ゲート (codex review P1): is_separated=true はクライアントの主張を
  // 鵜呑みにせず、body 自体に内部マーカー/センチネルが無いことをサーバで独立検証する。
  // これにより「parser が唯一の安全境界」を汎用 API でも担保 (混在 body を送信安全扱い
  // できる迂回を塞ぐ)。違反時は 400 で拒否し、決して保存しない。
  if (isSeparated && !isCustomerSafeBody(body)) {
    return NextResponse.json(
      {
        error:
          'is_separated=true requires customer-only body (internal markers/sentinels detected)',
      },
      { status: 400 },
    );
  }

  const sb = await getSupabaseAdmin();

  // ticket 存在確認
  const { data: ticket } = await sb
    .from('tickets')
    .select('id')
    .eq('id', params.id)
    .maybeSingle();
  if (!ticket) {
    return NextResponse.json({ error: 'ticket not found' }, { status: 404 });
  }

  const { data, error } = await sb
    .from('ticket_drafts')
    .insert({ ticket_id: params.id, body, source, is_separated: isSeparated })
    .select('id, body, source, is_separated, created_at')
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, draft: data });
}
