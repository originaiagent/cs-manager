/**
 * メール inbound → ticket 化 → origin-ai 返信ドラフト生成 → ticket_drafts 保存
 *
 * AI 集約原則: ドラフト生成は origin-ai 経由 (generateRagReply: pii-mask →
 * hybrid-search → reply-draft)。cs-manager 内に LLM 直叩き/prompt 直書きは無い。
 *
 * 冪等性: 同一 Message-ID の再送では inbound message が重複せず、ドラフトも
 * 再生成しない (upsertMessageReturningNew の isNew を gate に使う)。
 *
 * 安全性:
 *  - 実送信は一切行わない。draft は status='pending' で保存 (auto-approve しない)。
 *  - RAG 失敗でも ticket / message は残す (受信ロスト防止)。エラーは PII を含めず
 *    ticket.channel_meta.email_ingest に短く記録する。
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { NormalizedTicket, NormalizedMessage } from '@/channels/_lib/types';
import { formatChannelMessageId } from '@/channels/_lib/ids';
import { generateRagReply } from '@/lib/rag/reply-adapter';
import { upsertTicket, upsertMessageReturningNew } from '@/lib/sync/ingest';
import type { NormalizedEmailInbound } from './normalize';

export type EmailIngestStatus =
  | 'ingested_with_draft'
  | 'ingested_no_draft' // 新規だが RAG が draft を出さなかった (no_answer 等)
  | 'ingested_draft_failed' // 新規だが RAG 呼び出し失敗 (ticket は保存済)
  | 'duplicate' // 既知の Message-ID → 何もしない
  | 'unknown_recipient'; // 宛先 inbox 未登録 / 無効

/**
 * ドラフト生成失敗の安定コード。
 * codex High 指摘: upstream のエラーテキスト (raw 問い合わせ文を入力に持つ RAG の
 * 応答ボディ等) を DB / API 応答に流すと PII 漏洩リスクがあるため、外部に出すのは
 * この固定コードのみとし、生テキストは保持・返却しない。
 */
export type DraftErrorCode =
  | 'rag_upstream_error' // RAG エンドポイントが非 OK / draft 不正
  | 'rag_no_draft' // RAG は成功したが draft 空 (no_answer 等)
  | 'rag_exception' // RAG 呼び出し自体が例外 (ネットワーク等)
  | 'draft_persist_error'; // ticket_drafts への保存失敗

export interface EmailIngestResult {
  status: EmailIngestStatus;
  channelId?: string;
  ticketId?: string;
  draftId?: string;
  /** PII を含まない安定コードのみ (生のエラーテキストは載せない) */
  draftError?: DraftErrorCode;
}

interface ResolvedInbox {
  channelId: string;
}

/**
 * 宛先アドレスから active な channel_inboxes を解決する。
 * channel 自体も status='active' であることを要求する。
 */
async function resolveInbox(
  sb: SupabaseClient,
  toNormalized: string,
): Promise<ResolvedInbox | null> {
  // 生成列 normalized_address (lower(btrim(address))) の等価比較で正確に解決する
  // (DB の正規化契約と一致。表記揺れ・前後空白は生成列側で吸収済み)。
  const { data, error } = await sb
    .from('channel_inboxes')
    .select('channel_id, status, channels!inner(id, status)')
    .eq('normalized_address', toNormalized)
    .eq('status', 'active')
    .maybeSingle();
  if (error) throw new Error(`resolveInbox failed: ${error.message}`);
  if (!data) return null;

  const channel = Array.isArray((data as any).channels)
    ? (data as any).channels[0]
    : (data as any).channels;
  if (!channel || channel.status !== 'active') return null;
  return { channelId: (data as any).channel_id as string };
}

/**
 * ドラフト失敗を安定コードで ticket.channel_meta.email_ingest に記録する。
 * PII を含む生テキストは保存しない (codex High 指摘)。
 */
async function recordDraftError(
  sb: SupabaseClient,
  ticketId: string,
  code: DraftErrorCode,
): Promise<void> {
  const { data } = await sb
    .from('tickets')
    .select('channel_meta')
    .eq('id', ticketId)
    .maybeSingle();
  const meta = (data?.channel_meta ?? {}) as Record<string, unknown>;
  meta.email_ingest = {
    draft_error_code: code,
    at: new Date().toISOString(),
  };
  await sb.from('tickets').update({ channel_meta: meta }).eq('id', ticketId);
}

export async function ingestEmailInbound(
  sb: SupabaseClient,
  email: NormalizedEmailInbound,
): Promise<EmailIngestResult> {
  const inbox = await resolveInbox(sb, email.toNormalized);
  if (!inbox) {
    return { status: 'unknown_recipient' };
  }

  // 1 メール = 1 ticket (MVP)。external_id は Message-ID。
  // スレッド化する場合は threadMeta を使って既存 ticket に紐付ける拡張余地を残す。
  const ticketPayload: NormalizedTicket = {
    externalId: email.messageId,
    customerName: email.fromName ?? email.from ?? undefined,
    customerEmail: email.from ?? undefined,
    subject: email.subject ?? undefined,
    status: 'untouched',
    channelMeta: {
      source: 'email',
      to: email.to,
      message_id: email.messageId,
      thread: email.threadMeta,
    },
  };

  const ticketId = await upsertTicket(sb, inbox.channelId, ticketPayload);

  const inboundMsg: NormalizedMessage = {
    channelMessageId: formatChannelMessageId('inquiry', email.messageId),
    direction: 'inbound',
    body: email.text,
    senderName: email.fromName ?? email.from ?? undefined,
    senderType: 'customer',
    sentAt: email.receivedAt,
  };

  const { isNew } = await upsertMessageReturningNew(sb, ticketId, inboundMsg);
  if (!isNew) {
    return { status: 'duplicate', channelId: inbox.channelId, ticketId };
  }

  // origin-ai RAG でドラフト生成 (PII boundary は adapter 内で厳守)
  let ragResult;
  try {
    ragResult = await generateRagReply(sb, {
      subject: email.subject,
      inquiryBody: email.text,
      customerName: email.fromName ?? email.from ?? null,
      channelId: inbox.channelId,
      tenantId: null,
    });
  } catch (e) {
    // 例外メッセージは外部に出さない (PII 安全)。種別のみログ。
    console.error('[email-ingest] rag_exception', {
      name: e instanceof Error ? e.name : 'unknown',
    });
    await recordDraftError(sb, ticketId, 'rag_exception');
    return {
      status: 'ingested_draft_failed',
      channelId: inbox.channelId,
      ticketId,
      draftError: 'rag_exception',
    };
  }

  if (!ragResult.ok) {
    await recordDraftError(sb, ticketId, 'rag_upstream_error');
    return {
      status: 'ingested_draft_failed',
      channelId: inbox.channelId,
      ticketId,
      draftError: 'rag_upstream_error',
    };
  }
  if (!ragResult.draft || !ragResult.draft.trim()) {
    // RAG は成功したが回答なし (no_answer 等)。失敗ではないが draft は保存しない。
    await recordDraftError(sb, ticketId, 'rag_no_draft');
    return { status: 'ingested_no_draft', channelId: inbox.channelId, ticketId };
  }

  // 下書きを source='rag' / status='pending' (既定) で保存。auto-approve しない。
  const { data: draft, error: draftErr } = await sb
    .from('ticket_drafts')
    .insert({ ticket_id: ticketId, body: ragResult.draft, source: 'rag' })
    .select('id')
    .single();
  if (draftErr) {
    await recordDraftError(sb, ticketId, 'draft_persist_error');
    return {
      status: 'ingested_draft_failed',
      channelId: inbox.channelId,
      ticketId,
      draftError: 'draft_persist_error',
    };
  }

  return {
    status: 'ingested_with_draft',
    channelId: inbox.channelId,
    ticketId,
    draftId: draft.id as string,
  };
}
