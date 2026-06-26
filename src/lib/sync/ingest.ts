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

  // subject は baseUpdate から意図的に除外する (codex CONCERN#1: subject clobber 防止)。
  // ticket の subject 書き込み口は resolveAndPersistSubject 1 箇所に収束する。
  // 既存行 update / 新規 insert のいずれも subject を設定せず、NULL のまま作成する。
  const baseUpdate = {
    customer_name: payload.customerName ?? null,
    customer_email: payload.customerEmail ?? null,
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

/**
 * 複数メッセージを冪等 insert し、「新規挿入された inbound メッセージ」を返す (pull 経路共通)。
 *
 * codex CONCERN#2 反映: pull 経路 (orchestrator / rakuten-sync) は従来 bulk upsert の件数しか
 * 返さず「新規 inbound か否か」を識別できなかった。本ヘルパは各メッセージを atomic insert し、
 * 新規挿入された inbound のみ収集して返す。これにより
 *  - 新規 inbound (=顧客の新着) のみ subject / draft を発火できる、
 *  - outbound-only 更新・再送 (isNew=false) では発火しない、
 * を共通契約として保証する。各メッセージは immutable 前提のため insert-only (既存行は更新しない)。
 */
export async function upsertMessagesReturningNew(
  sb: SupabaseClient,
  ticketId: string,
  messages: NormalizedMessage[],
): Promise<{ count: number; newInbound: NormalizedMessage[]; errorCount: number }> {
  let count = 0;
  let errorCount = 0;
  const newInbound: NormalizedMessage[] = [];
  for (const m of messages) {
    // codex PR review P3 (atomicity): 1 メッセージの insert 失敗で batch 全体を中断しない。
    // 失敗メッセージは insert されず isNew にもならない → 次 sync で再試行される (self-healing)。
    // これにより、先行して insert 済みの inbound に対する subject / draft 発火が
    // 後続メッセージの失敗で恒久的にブロックされる事態を防ぐ (fail-closed)。
    let isNew = false;
    try {
      ({ isNew } = await upsertMessageReturningNew(sb, ticketId, m));
    } catch {
      errorCount += 1;
      continue;
    }
    if (!isNew) continue;
    count += 1;
    if (m.direction === 'inbound') newInbound.push(m);
  }
  return { count, newInbound, errorCount };
}

/** newInbound 群から「最新 (sentAt 最大) の inbound」を返す。空なら null。 */
export function latestInbound(
  newInbound: NormalizedMessage[],
): NormalizedMessage | null {
  if (newInbound.length === 0) return null;
  return newInbound.reduce((a, b) =>
    Date.parse(b.sentAt) > Date.parse(a.sentAt) ? b : a,
  );
}
