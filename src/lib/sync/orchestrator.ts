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
import { getCredential, CredentialFetchError } from '@/lib/credentials';

/**
 * pull チャネルが Core から解決してよい service_code の allowlist (codex 設計レビュー guard)。
 * channels.config は service_role 限定だが、万一改竄された config が任意の service_code を
 * 指定して他サービスの Vault 鍵を引き出すのを防ぐ多層防御。新 pull チャネル追加時にここへ足す。
 */
const ALLOWED_PULL_SERVICE_CODES = new Set<string>(['yahoo_shopping']);

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

export type CredentialResolution =
  | { kind: 'ok'; credentials: Record<string, unknown> }
  | { kind: 'skip'; reason: string }
  | { kind: 'error'; error: string };

/**
 * pull チャネルの credential を config 駆動で Core から解決する。
 *
 * - config.service_code 必須・allowlist 内であること (無効は misconfig=error)。
 * - scope_key は config[config.scope_key_field ?? 'scope_key'] から引く。
 * - Core 404 (キー未投入) → graceful skip (「キー入れるだけ」で次 tick から稼働)。
 * - その他 (401/500/network) → error (再試行対象)。
 *
 * getCred は注入可能 (テストで Core を差し替え、「キー投入で skip→稼働に切替わる」ことを実証する)。
 */
export async function resolvePullCredentials(
  channel: ChannelRow,
  logger: AdapterLogger,
  getCred: typeof getCredential = getCredential,
): Promise<CredentialResolution> {
  const cfg = (channel.config ?? {}) as Record<string, unknown>;
  const serviceCode = typeof cfg.service_code === 'string' ? cfg.service_code.trim() : '';
  if (!serviceCode) {
    return { kind: 'error', error: `pull channel misconfig: channels.config.service_code is required (channel_id=${channel.id})` };
  }
  if (!ALLOWED_PULL_SERVICE_CODES.has(serviceCode)) {
    return { kind: 'error', error: `pull channel misconfig: service_code='${serviceCode}' not in allowlist (channel_id=${channel.id})` };
  }
  const scopeKeyField = typeof cfg.scope_key_field === 'string' && cfg.scope_key_field.trim()
    ? cfg.scope_key_field.trim()
    : 'scope_key';
  const scopeKeyRaw = cfg[scopeKeyField];
  const scopeKey = typeof scopeKeyRaw === 'string' && scopeKeyRaw.trim() ? scopeKeyRaw.trim() : null;

  try {
    const resp = await getCred(serviceCode, scopeKey);
    return { kind: 'ok', credentials: resp.credentials as Record<string, unknown> };
  } catch (err) {
    if (err instanceof CredentialFetchError && err.status === 404) {
      logger.info('skip_no_credential', { serviceCode, hasScopeKey: scopeKey !== null });
      return { kind: 'skip', reason: 'no_credential_in_core' };
    }
    return {
      kind: 'error',
      error: `credential resolution failed for service_code='${serviceCode}': ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function syncOneChannel(
  channel: ChannelRow,
  credentials: Record<string, unknown>,
): Promise<ChannelSyncResult> {
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
    credentials,
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
    const logger = makeLogger(ch.code);
    // 受信機構は channels.config.ingestion で宣言 (データ駆動)。
    //  - 'inbound_webhook' (メール転送) / 'push_webhook' (LINE 等) は各 webhook endpoint が
    //    受信するため本 pull cron の対象外。明示的な push 指定のみ skip する。
    //  - 'pull' (または未指定の後方互換) は credential を Core から解決して adapter 実行。
    const ingestion = (ch.config as Record<string, unknown>)?.ingestion;
    if (ingestion === 'inbound_webhook' || ingestion === 'push_webhook') {
      logger.info('skip_non_pull_channel', { channelId: ch.id, ingestion });
      continue;
    }

    // pull チャネル: 「キー入れるだけ」の心臓部。config 駆動で credential を Core 解決し、
    // キー未投入 (404) は graceful skip、解決できれば adapter に注入して受信開始。
    const cred = await resolvePullCredentials(ch, logger);
    if (cred.kind === 'skip') {
      continue; // キー未投入: error にしない (次 tick でキーがあれば自動稼働)
    }
    if (cred.kind === 'error') {
      logger.error('credential_resolution_error', { channelId: ch.id });
      results.push({
        channelCode: ch.code,
        channelId: ch.id,
        ticketsProcessed: 0,
        messagesUpserted: 0,
        error: cred.error,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });
      continue;
    }
    const r = await syncOneChannel(ch, cred.credentials);
    results.push(r);
  }
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    channels: results,
  };
}
