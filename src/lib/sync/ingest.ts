/**
 * チャネル横断の共通取込ヘルパ (ticket + message の upsert)
 *
 * 目的:
 *  - push 型チャネル (メール inbound webhook 等) と将来の pull adapter が
 *    同一の正規化型 (NormalizedTicket / NormalizedMessage) で ticket/messages を
 *    保存できる共通経路を提供する。
 *  - 冪等性: message は (ticket_id, channel_message_id) UNIQUE で重複排除し、
 *    「新規メッセージか否か」を呼び出し側に返す (ドラフト二重生成防止のため)。
 *
 * 注: 既存の楽天 sync (orchestrator.ts / rakuten-sync route) は実績ある独自実装を
 *     そのまま残す (回帰回避)。本ヘルパは新規 push 経路でのみ使用する。
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  NormalizedMessage,
  NormalizedTicket,
} from '@/channels/_lib/types';

/**
 * ticket を (channel_id, external_id) で upsert し id を返す。
 * 既存行の status は踏み潰さない (untouched→done の自動遷移のみ許可)。
 */
export async function upsertTicket(
  sb: SupabaseClient,
  channelId: string,
  payload: NormalizedTicket,
): Promise<string> {
  const { data: existing, error: selErr } = await sb
    .from('tickets')
    .select('id, status')
    .eq('channel_id', channelId)
    .eq('external_id', payload.externalId)
    .maybeSingle();
  if (selErr) throw new Error(`ingest.upsertTicket(select) failed: ${selErr.message}`);

  const baseUpdate = {
    customer_name: payload.customerName ?? null,
    customer_email: payload.customerEmail ?? null,
    subject: payload.subject ?? null,
    channel_meta: payload.channelMeta ?? {},
    resolved_at: payload.resolvedAt ?? null,
  };

  if (existing) {
    const update = {
      ...baseUpdate,
      ...(existing.status === 'untouched' && payload.status === 'done'
        ? { status: 'done' }
        : {}),
    };
    const { error: updErr } = await sb
      .from('tickets')
      .update(update)
      .eq('id', existing.id);
    if (updErr) throw new Error(`ingest.upsertTicket(update) failed: ${updErr.message}`);
    return existing.id as string;
  }

  // 競合時 (並行受信) は ignoreDuplicates にして後段 select で id を引く
  const { error: upErr } = await sb.from('tickets').upsert(
    {
      channel_id: channelId,
      external_id: payload.externalId,
      ...baseUpdate,
      status: payload.status,
    },
    { onConflict: 'channel_id,external_id', ignoreDuplicates: true },
  );
  if (upErr) throw new Error(`ingest.upsertTicket(upsert) failed: ${upErr.message}`);

  const { data: postSel, error: postErr } = await sb
    .from('tickets')
    .select('id')
    .eq('channel_id', channelId)
    .eq('external_id', payload.externalId)
    .single();
  if (postErr) throw new Error(`ingest.upsertTicket(post-select) failed: ${postErr.message}`);
  return postSel.id as string;
}

/** Postgres unique_violation */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * inbound message を冪等 insert し、新規挿入されたかを返す。
 * 同一 channel_message_id の再送 (並行リクエスト含む) では isNew=false。
 *
 * 判定は「素の insert → unique 違反(23505)で既存」で行う。DB の
 * (ticket_id, channel_message_id) UNIQUE を真実の源とするため、select→insert の
 * チェック窓に起因する二重ドラフト生成を回避できる。
 */
export async function upsertMessageReturningNew(
  sb: SupabaseClient,
  ticketId: string,
  msg: NormalizedMessage,
): Promise<{ isNew: boolean }> {
  const { error: insErr } = await sb.from('messages').insert({
    ticket_id: ticketId,
    channel_message_id: msg.channelMessageId,
    direction: msg.direction,
    body: msg.body,
    sender_name: msg.senderName ?? null,
    sent_at: msg.sentAt,
    attachments: msg.attachments ?? [],
  });
  if (!insErr) return { isNew: true };
  if ((insErr as { code?: string }).code === PG_UNIQUE_VIOLATION) {
    return { isNew: false };
  }
  throw new Error(`ingest.upsertMessage(insert) failed: ${insErr.message}`);
}
