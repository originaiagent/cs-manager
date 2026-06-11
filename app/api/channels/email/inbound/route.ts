import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import { authorizeApiRoute } from '@/lib/auth/api-auth';
import {
  normalizeEmailInbound,
  MAX_EMAIL_TEXT_LENGTH,
  type RawEmailInbound,
} from '@/lib/email/normalize';
import { ingestEmailInbound } from '@/lib/email/ingest-email';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * メール inbound webhook (push 型チャネルの 2 例目)
 *
 * 流れ: 正規化ペイロード受信 → channel_inboxes(active) で宛先解決 → ticket 化 →
 *       origin-ai RAG で返信ドラフト生成 → ticket_drafts(source='rag', status='pending') 保存。
 *
 * 認可: tier='cron' (`Authorization: Bearer ${CRON_SECRET}` または手動 `X-Diag-Token`)。
 *       本番で実フォワーダを繋ぐ際は専用 webhook secret への切替を推奨 (ゲート項目)。
 *
 * 安全性:
 *  - 実送信は行わない (下書き保存まで)。
 *  - body サイズ・スキーマを検証。エラー・ログに PII (本文/アドレス) を出さない。
 */

// ペイロード全体の上限 (本文上限 + ヘッダ余白)
const MAX_BODY_BYTES = MAX_EMAIL_TEXT_LENGTH + 16_384;

export async function POST(req: NextRequest) {
  const authError = authorizeApiRoute(req, { tier: 'cron' });
  if (authError) return authError;

  // body サイズガード (Content-Length が信頼できない場合は読み取り後に再確認)
  const declaredLen = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: 'payload too large' }, { status: 413 });
  }

  const rawText = await req.text();
  if (rawText.length > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: 'payload too large' }, { status: 413 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }
  // null / 配列 / プリミティブは拒否 (JSON object 必須)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return NextResponse.json({ ok: false, error: 'json object required' }, { status: 400 });
  }
  const raw = parsed as RawEmailInbound;

  const normalized = normalizeEmailInbound(raw, new Date().toISOString());
  if (!normalized.ok) {
    // フィールド名のみ返す (値=PII は返さない)
    return NextResponse.json(
      { ok: false, error: 'validation failed', fields: normalized.errors },
      { status: 422 },
    );
  }

  const sb = await getSupabaseAdmin();
  let result;
  try {
    result = await ingestEmailInbound(sb, normalized.value);
  } catch (err) {
    // PII を含めない汎用エラー (詳細は server log 側、ただし本文は出さない)
    console.error('[email-inbound] ingest failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ ok: false, error: 'ingest failed' }, { status: 500 });
  }

  if (result.status === 'unknown_recipient') {
    return NextResponse.json(
      { ok: false, error: 'unknown recipient' },
      { status: 404 },
    );
  }

  return NextResponse.json({
    ok: true,
    status: result.status,
    channelId: result.channelId ?? null,
    ticketId: result.ticketId ?? null,
    draftId: result.draftId ?? null,
    draftError: result.draftError ?? null,
  });
}
