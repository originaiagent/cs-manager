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

export interface EmailIngestResult {
  status: EmailIngestStatus;
  channelId?: string;
  ticketId?: string;
  draftId?: string;
  draftError?: string;
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
  // ilike で大小文字差を吸収して候補を絞り、JS 側で正規化一致を最終確認する
  // (一意制約は lower(btrim(address)) のため、表記揺れは正規化で吸収)。
  const { data, error } = await sb
    .from('channel_inboxes')
    .select('address, channel_id, status, channels!inner(id, status)')
    .ilike('address', toNormalized)
    .eq('status', 'active');
  if (error) throw new Error(`resolveInbox failed: ${error.message}`);

  for (const row of (data ?? []) as any[]) {
    const addr = String(row.address ?? '');
    if (addr.trim().toLowerCase() !== toNormalized) continue;
    const channel = Array.isArray(row.channels) ? row.channels[0] : row.channels;
    if (!channel || channel.status !== 'active') continue;
    return { channelId: row.channel_id as string };
  }
  return null;
}

/** PII を含めない短いエラー記録を ticket.channel_meta.email_ingest に書く。 */
async function recordDraftError(
  sb: SupabaseClient,
  ticketId: string,
  shortError: string,
): Promise<void> {
  const { data } = await sb
    .from('tickets')
    .select('channel_meta')
    .eq('id', ticketId)
    .maybeSingle();
  const meta = (data?.channel_meta ?? {}) as Record<string, unknown>;
  meta.email_ingest = {
    draft_error: shortError.slice(0, 200),
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
    const msg = e instanceof Error ? e.message : String(e);
    await recordDraftError(sb, ticketId, msg);
    return { status: 'ingested_draft_failed', channelId: inbox.channelId, ticketId, draftError: msg };
  }

  if (!ragResult.ok || !ragResult.draft || !ragResult.draft.trim()) {
    const msg = ragResult.error ?? 'RAG が返信ドラフトを生成しませんでした';
    await recordDraftError(sb, ticketId, msg);
    return {
      status: ragResult.ok ? 'ingested_no_draft' : 'ingested_draft_failed',
      channelId: inbox.channelId,
      ticketId,
      draftError: ragResult.ok ? undefined : msg,
    };
  }

  // 下書きを source='rag' / status='pending' (既定) で保存。auto-approve しない。
  const { data: draft, error: draftErr } = await sb
    .from('ticket_drafts')
    .insert({ ticket_id: ticketId, body: ragResult.draft, source: 'rag' })
    .select('id')
    .single();
  if (draftErr) {
    await recordDraftError(sb, ticketId, draftErr.message);
    return {
      status: 'ingested_draft_failed',
      channelId: inbox.channelId,
      ticketId,
      draftError: draftErr.message,
    };
  }

  return {
    status: 'ingested_with_draft',
    channelId: inbox.channelId,
    ticketId,
    draftId: draft.id as string,
  };
}
