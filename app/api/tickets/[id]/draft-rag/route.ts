import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import { authorizeInternalApiKey } from '@/lib/auth/internal-api-key';
import { generateRagReply } from '@/lib/rag/reply-adapter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const MAX_THREAD_MESSAGES = 10;

/**
 * RAG 返信案生成 (引用元付き)
 *
 * - cs-manager 内には LLM 直接呼出・プロンプトを書かない (AI 集約原則)
 * - origin-ai の RAG skill (pii-mask → hybrid-search → reply-draft) を adapter で
 *   オーケストレーション。PII boundary 厳守 (外部送信は masked のみ、復元はローカル)
 * - 戻りドラフトは保存せず、UI が「採用」した時点で /drafts に source='rag' で保存される
 * - 営業時間判定: is_within_business_hours(channel_id) を併せて返す
 *   (営業時間内は draft 限定 = 人間 click。営業時間外フローの自動送信は Phase2 対象外)
 *
 * 認可: X-Internal-API-Key ヘッダ必須 (Server Action 経由でのみ呼び出し可)。
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const authError = authorizeInternalApiKey(req);
  if (authError) return authError;

  const startedAt = Date.now();
  const sb = await getSupabaseAdmin();

  // 1. ticket 取得 (raw PII 含む、外部には送らない)
  const { data: ticket, error: ticketError } = await sb
    .from('tickets')
    .select('id, customer_name, subject, status, product_id, case_category, channel_id')
    .eq('id', params.id)
    .maybeSingle();
  if (ticketError) {
    return NextResponse.json({ ok: false, error: ticketError.message }, { status: 500 });
  }
  if (!ticket) {
    return NextResponse.json({ ok: false, error: 'ticket not found' }, { status: 404 });
  }

  // 2. 最新の inbound メッセージ本文を問い合わせ文として使う (古い順 → 末尾 N 件)
  const { data: allMessages } = await sb
    .from('messages')
    .select('direction, body, sent_at')
    .eq('ticket_id', ticket.id)
    .order('sent_at', { ascending: true });
  const recent = (allMessages ?? []).slice(-MAX_THREAD_MESSAGES);
  // 直近の inbound (顧客発) を優先。無ければ末尾メッセージ。
  const inbound = recent.filter((m) => m.direction === 'inbound');
  const inquiryBody =
    (inbound.length > 0 ? inbound[inbound.length - 1] : recent[recent.length - 1])?.body ?? '';

  // 3b. 低 confidence 警告の閾値 (codex R3 #6: UI ハードコード除去、rag_config 駆動)
  //     キー欠落 / 不正値時は既定 0.5。UI はこの値で「人間確認推奨」警告を出す。
  const DEFAULT_LOW_CONFIDENCE_THRESHOLD = 0.5;
  let lowConfidenceThreshold = DEFAULT_LOW_CONFIDENCE_THRESHOLD;
  {
    const { data: thRow } = await sb
      .from('rag_config')
      .select('config_value')
      .eq('config_key', 'rag_low_confidence_threshold')
      .maybeSingle();
    const v = thRow?.config_value;
    const parsed =
      typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
      lowConfidenceThreshold = parsed;
    }
  }

  // 3. 営業時間判定 (channel_id が無い場合は判定不可 = null)
  let withinBusinessHours: boolean | null = null;
  if (ticket.channel_id) {
    const { data: bh, error: bhError } = await sb.rpc('is_within_business_hours', {
      channel_id_param: ticket.channel_id,
      check_time: new Date().toISOString(),
    });
    if (!bhError && typeof bh === 'boolean') withinBusinessHours = bh;
  }

  // 4. RAG 返信案生成 (PII boundary は adapter 内で厳守)
  const result = await generateRagReply(sb, {
    subject: ticket.subject ?? null,
    inquiryBody,
    customerName: ticket.customer_name ?? null,
    channelId: ticket.channel_id ?? null,
    tenantId: null,
  });

  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: result.error ?? 'RAG 返信案生成に失敗しました',
        maskFailed: result.maskFailed ?? false,
        withinBusinessHours,
        durationMs: Date.now() - startedAt,
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    draft: result.draft ?? '',
    citations: result.citations ?? [],
    confidence: result.confidence ?? null,
    noAnswer: result.noAnswer ?? false,
    needsHuman: result.needsHuman ?? false,
    model: result.model ?? null,
    searchHitCount: result.searchHitCount ?? 0,
    withinBusinessHours,
    lowConfidenceThreshold,
    durationMs: Date.now() - startedAt,
  });
}
