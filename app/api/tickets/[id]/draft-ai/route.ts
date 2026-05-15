import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import { fetchProductById, type CoreProduct } from '@/lib/core-client';
import { invokeChat } from '@/lib/ai-client';
import { extractDraftFromAiResponse } from '@/lib/draft-extract';
import { authorizeInternalApiKey } from '@/lib/auth/internal-api-key';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const SKILL_NAME = 'cs_reply_draft_generation';
const MAX_THREAD_MESSAGES = 10;

/**
 * Phase 1.3: AI返信ドラフト生成
 *
 * - cs-manager 内には LLM 直接呼出・プロンプトを書かない (AI集約原則)
 * - origin-ai の skill `cs_reply_draft_generation` に構造化入力を渡し、ドラフト本文を受け取る
 * - 製品情報は Core /api/v1/master/products/{id} から取得 (B案原則)
 * - 戻りドラフトは保存せず、cs-manager UI が「採用」した時点で /drafts に保存される
 *
 * 認可: X-Internal-API-Key ヘッダ必須 (Server Action 経由でのみ呼び出し可)。
 * 第三者からの LLM コスト消費・顧客文言抽出を遮断する目的 (backlog e6520f91)。
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const authError = authorizeInternalApiKey(req);
  if (authError) return authError;

  const startedAt = Date.now();
  const sb = getSupabaseAdmin();

  // 1. ticket 取得
  const { data: ticket, error: ticketError } = await sb
    .from('tickets')
    .select(
      'id, customer_name, subject, status, product_id, case_category, channel_meta, channels(display_name)',
    )
    .eq('id', params.id)
    .maybeSingle();
  if (ticketError) {
    return NextResponse.json({ ok: false, error: ticketError.message }, { status: 500 });
  }
  if (!ticket) {
    return NextResponse.json({ ok: false, error: 'ticket not found' }, { status: 404 });
  }

  // 2. messages 取得 (古い順 → 末尾 N 件)
  const { data: allMessages } = await sb
    .from('messages')
    .select('direction, body, sender_name, sent_at')
    .eq('ticket_id', ticket.id)
    .order('sent_at', { ascending: true });
  const messages = (allMessages ?? []).slice(-MAX_THREAD_MESSAGES);

  // 3. 製品情報を Core から並列取得
  let product: CoreProduct | null = null;
  if (ticket.product_id) {
    const r = await fetchProductById(ticket.product_id);
    if (r.ok && r.product) product = r.product;
  }
  const productAvailable = !!product;

  // 4. origin-ai 用メッセージ構築 (skill matcher が cs_reply_draft_generation を確実に選ぶよう先頭に skill タグ)
  const productInfoText = product
    ? JSON.stringify(
        {
          id: product.id,
          product_name: product.product_name,
          variation: product.variation ?? null,
          group_name: product.group_name ?? null,
          jan_code: product.jan_code ?? null,
        },
        null,
        2,
      )
    : 'null';

  const threadText = messages
    .map((m) => {
      const dir = m.direction === 'inbound' ? 'inbound' : 'outbound';
      return `- ${dir} (${m.sender_name ?? '不明'} / ${m.sent_at}): ${m.body}`;
    })
    .join('\n');

  const message = [
    `[skill: ${SKILL_NAME}] CS返信ドラフトを生成してください。`,
    '',
    '## ticket_subject',
    ticket.subject ?? '(件名なし)',
    '',
    '## customer_name',
    ticket.customer_name ?? '(顧客名不明)',
    '',
    '## case_category',
    ticket.case_category ?? 'null',
    '',
    '## product_info',
    productInfoText,
    '',
    '## product_available',
    String(productAvailable),
    '',
    '## message_thread (古い順、末尾10件まで)',
    threadText || '(メッセージなし)',
  ].join('\n');

  // 5. invokeChat: AI集約デフォルト agent (core_assistant) を回避するため agent_name="" を明示
  const result = await invokeChat(message, { agentName: '' });

  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: result.error ?? 'AI invocation failed',
        traceId: result.traceId,
        durationMs: Date.now() - startedAt,
      },
      { status: 502 },
    );
  }

  // 6. 戻り message から draft 部分のみ抽出
  const draft = extractDraftFromAiResponse(result.message, result.structuredOutput);

  return NextResponse.json({
    ok: true,
    draft,
    rawMessage: result.message,
    skillUsed: result.skillUsed?.name ?? null,
    skillDisplayName: result.skillUsed?.displayName ?? null,
    sessionId: result.skillUsed?.sessionId ?? null,
    productAvailable,
    threadCount: messages.length,
    traceId: result.traceId,
    durationMs: Date.now() - startedAt,
  });
}
