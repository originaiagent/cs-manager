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
import { ingestInboundWithDraft, type DraftErrorCode } from '@/lib/sync/ingest-inbound';
import type { NormalizedEmailInbound } from './normalize';

export type EmailIngestStatus =
  | 'ingested_with_draft'
  | 'ingested_no_draft' // 新規だが RAG が draft を出さなかった (no_answer 等)
  | 'ingested_draft_failed' // 新規だが RAG 呼び出し失敗 (ticket は保存済)
  | 'duplicate' // 既知の Message-ID → 何もしない
  | 'unknown_recipient'; // 宛先 inbox 未登録 / 無効

/**
 * ドラフト生成失敗の安定コード (PII を含まない)。共通 ingest から再 export し後方互換を保つ。
 * codex High 指摘: upstream のエラーテキスト (raw 問い合わせ文を入力に持つ RAG の
 * 応答ボディ等) を DB / API 応答に流すと PII 漏洩リスクがあるため、外部に出すのは
 * この固定コードのみとし、生テキストは保持・返却しない。
 */
export type { DraftErrorCode };

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

  const inboundMsg: NormalizedMessage = {
    channelMessageId: formatChannelMessageId('inquiry', email.messageId),
    direction: 'inbound',
    body: email.text,
    senderName: email.fromName ?? email.from ?? undefined,
    senderType: 'customer',
    sentAt: email.receivedAt,
  };

  // 取込 + ドラフト生成は channel 非依存の共通 ingest に委譲。
  // 宛先解決 (resolveInbox) と channel_meta への失敗記録 (email 固有キー) は email 側の責務。
  const r = await ingestInboundWithDraft(sb, {
    channelId: inbox.channelId,
    ticket: ticketPayload,
    inboundMessage: inboundMsg,
    ragInput: {
      subject: email.subject,
      inquiryBody: email.text,
      customerName: email.fromName ?? email.from ?? null,
      channelId: inbox.channelId,
      tenantId: null,
    },
  });

  // 失敗系は安定コードを channel_meta.email_ingest に記録 (現行契約を維持)。
  if (r.draftError) {
    await recordDraftError(sb, r.ticketId, r.draftError);
  }

  // 外部応答の draftError は ingested_draft_failed のときのみ載せる (現行契約: no_draft では載せない)。
  return {
    status: r.status,
    channelId: inbox.channelId,
    ticketId: r.ticketId,
    ...(r.draftId ? { draftId: r.draftId } : {}),
    ...(r.status === 'ingested_draft_failed' && r.draftError ? { draftError: r.draftError } : {}),
  };
}
