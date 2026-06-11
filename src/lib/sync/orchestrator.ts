import { getChannelAdapter } from '@/channels/_lib/registry';
import type {
  AdapterLogger,
  ChannelAdapterContext,
} from '@/channels/_lib/adapter';
import type {
  NormalizedMessage,
  NormalizedTicketWithMessages,
} from '@/channels/_lib/types';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';

/**
 * チャネル取込 orchestrator
 *
 * 責務:
 *  - active な channels を列挙
 *  - 各チャネルの adapter を呼び、yield された ticket+messages を upsert
 *  - 1 ticket 処理ごとに channel_sync_state.last_synced_at を進める（部分失敗時の再スキャン幅を最小化）
 *  - チャネル単位で try/catch、全チャネル横断のロールバックはしない
 */

export interface ChannelSyncResult {
  channelCode: string;
  channelId: string;
  ticketsProcessed: number;
  messagesUpserted: number;
  error?: string;
  startedAt: string;
  finishedAt: string;
}

export interface SyncRunResult {
  startedAt: string;
  finishedAt: string;
  channels: ChannelSyncResult[];
}

interface ChannelRow {
  id: string;
  code: string;
  config: Record<string, unknown>;
}

function makeLogger(channelCode: string): AdapterLogger {
  const prefix = `[sync:${channelCode}]`;
  const fmt = (extra?: Record<string, unknown>) =>
    extra ? ` ${JSON.stringify(extra)}` : '';
  return {
    info: (msg, extra) => console.log(`${prefix} ${msg}${fmt(extra)}`),
    warn: (msg, extra) => console.warn(`${prefix} ${msg}${fmt(extra)}`),
    error: (msg, extra) => console.error(`${prefix} ${msg}${fmt(extra)}`),
  };
}

async function loadActiveChannels(): Promise<ChannelRow[]> {
  const supa = await getSupabaseAdmin();
  // 楽天は credential 動的取得 + 送信フローを含む専用 cron (/api/cron/rakuten-sync, 5分間隔)
  // で処理するため、汎用 cron からは除外する (二重取込・競合防止)。
  const { data, error } = await supa
    .from('channels')
    .select('id, code, config')
    .eq('status', 'active')
    .neq('code', 'rakuten');
  if (error) throw new Error(`loadActiveChannels failed: ${error.message}`);
  return (data ?? []) as ChannelRow[];
}

async function loadSyncState(channelId: string): Promise<Date | null> {
  const supa = await getSupabaseAdmin();
  const { data, error } = await supa
    .from('channel_sync_state')
    .select('last_synced_at')
    .eq('channel_id', channelId)
    .maybeSingle();
  if (error) throw new Error(`loadSyncState failed: ${error.message}`);
  if (!data?.last_synced_at) return null;
  return new Date(data.last_synced_at);
}

async function persistSyncState(channelId: string, lastSyncedAt: Date, lastExternalId?: string) {
  const supa = await getSupabaseAdmin();
  const { error } = await supa
    .from('channel_sync_state')
    .upsert(
      {
        channel_id: channelId,
        last_synced_at: lastSyncedAt.toISOString(),
        last_external_id: lastExternalId ?? null,
      },
      { onConflict: 'channel_id' },
    );
  if (error) throw new Error(`persistSyncState failed: ${error.message}`);
}

async function upsertTicket(
  channelId: string,
  payload: NormalizedTicketWithMessages['ticket'],
): Promise<string> {
  const supa = await getSupabaseAdmin();
  // status は cs-manager 内部で書き換わる可能性があるため、新規作成時のみ adapter 値を採用。
  // 既存行に対しては customer / subject / channel_meta / resolved_at だけ更新する方針。
  // ここでは select → insert/update を分岐して安全に扱う。
  const { data: existing, error: selErr } = await supa
    .from('tickets')
    .select('id, status')
    .eq('channel_id', channelId)
    .eq('external_id', payload.externalId)
    .maybeSingle();
  if (selErr) throw new Error(`upsertTicket(select) failed: ${selErr.message}`);

  if (existing) {
    const { error: updErr } = await supa
      .from('tickets')
      .update({
        customer_name: payload.customerName ?? null,
        customer_email: payload.customerEmail ?? null,
        subject: payload.subject ?? null,
        channel_meta: payload.channelMeta ?? {},
        resolved_at: payload.resolvedAt ?? null,
        // status: untouched から done への遷移のみ自動適用（in_progress を踏み潰さない）
        ...(existing.status === 'untouched' && payload.status === 'done'
          ? { status: 'done' }
          : {}),
      })
      .eq('id', existing.id);
    if (updErr) throw new Error(`upsertTicket(update) failed: ${updErr.message}`);
    return existing.id as string;
  }

  const { data: ins, error: insErr } = await supa
    .from('tickets')
    .insert({
      channel_id: channelId,
      external_id: payload.externalId,
      customer_name: payload.customerName ?? null,
      customer_email: payload.customerEmail ?? null,
      subject: payload.subject ?? null,
      status: payload.status,
      resolved_at: payload.resolvedAt ?? null,
      channel_meta: payload.channelMeta ?? {},
    })
    .select('id')
    .single();
  if (insErr) throw new Error(`upsertTicket(insert) failed: ${insErr.message}`);
  return ins.id as string;
}

async function upsertMessages(
  ticketId: string,
  messages: NormalizedMessage[],
): Promise<number> {
  if (messages.length === 0) return 0;
  const supa = await getSupabaseAdmin();
  const rows = messages.map((m) => ({
    ticket_id: ticketId,
    channel_message_id: m.channelMessageId,
    direction: m.direction,
    body: m.body,
    sender_name: m.senderName ?? null,
    sent_at: m.sentAt,
    attachments: m.attachments ?? [],
  }));
  const { error, count } = await supa
    .from('messages')
    .upsert(rows, { onConflict: 'ticket_id,channel_message_id', count: 'exact' });
  if (error) throw new Error(`upsertMessages failed: ${error.message}`);
  return count ?? rows.length;
}

async function syncOneChannel(channel: ChannelRow): Promise<ChannelSyncResult> {
  const startedAt = new Date();
  const logger = makeLogger(channel.code);
  const adapter = getChannelAdapter(channel.code);
  if (!adapter) {
    return {
      channelCode: channel.code,
      channelId: channel.id,
      ticketsProcessed: 0,
      messagesUpserted: 0,
      error: `no adapter registered for code='${channel.code}'`,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
    };
  }

  let since: Date | null = null;
  try {
    since = await loadSyncState(channel.id);
  } catch (err) {
    logger.warn('loadSyncState_failed_falling_back_null', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const ctx: ChannelAdapterContext = {
    channel: { id: channel.id, code: channel.code, config: channel.config ?? {} },
    since,
    logger,
  };

  let ticketsProcessed = 0;
  let messagesUpserted = 0;
  let lastSyncedAt = startedAt;
  let lastExternalId: string | undefined;
  let errorMessage: string | undefined;

  try {
    for await (const item of adapter.fetchInbox(ctx)) {
      const ticketId = await upsertTicket(channel.id, item.ticket);
      const inserted = await upsertMessages(ticketId, item.messages);
      ticketsProcessed += 1;
      messagesUpserted += inserted;
      lastExternalId = item.ticket.externalId;
      // 1 件ごとに sync_state を進める（部分失敗時の再スキャン幅を最小化）
      const observedAt = new Date();
      lastSyncedAt = observedAt;
      try {
        await persistSyncState(channel.id, observedAt, lastExternalId);
      } catch (err) {
        logger.warn('persistSyncState_failed_continuing', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    logger.error('fetchInbox_failed', { error: errorMessage });
  }

  // 正常完了時は startedAt を sync 起点として記録（次回はそこから引く）
  if (!errorMessage) {
    try {
      await persistSyncState(channel.id, startedAt, lastExternalId);
    } catch (err) {
      logger.warn('persistSyncState_finalize_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    channelCode: channel.code,
    channelId: channel.id,
    ticketsProcessed,
    messagesUpserted,
    error: errorMessage,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
  };
}

export async function runChannelSync(): Promise<SyncRunResult> {
  const startedAt = new Date();
  const channels = await loadActiveChannels();
  const results: ChannelSyncResult[] = [];
  for (const ch of channels) {
    // push 型チャネル (config.ingestion='inbound_webhook'、例: メール) は webhook で
    // 受信するため本 pull cron の対象外。明示的な push 指定のみ skip し、それ以外の
    // adapter 不在は misconfig として error 結果に残す (codex Medium 指摘)。
    const ingestion = (ch.config as Record<string, unknown>)?.ingestion;
    if (ingestion === 'inbound_webhook') {
      makeLogger(ch.code).info('skip_push_channel', { channelId: ch.id, ingestion });
      continue;
    }
    const r = await syncOneChannel(ch);
    results.push(r);
  }
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    channels: results,
  };
}
