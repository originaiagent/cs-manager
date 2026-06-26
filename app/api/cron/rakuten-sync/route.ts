import { NextRequest, NextResponse } from 'next/server';
import { rakutenAdapter } from '@/channels/rakuten/adapter';
import { sendApprovedDrafts } from '@/channels/rakuten/outbound';
import type { AdapterLogger, ChannelAdapterContext } from '@/channels/_lib/adapter';
import type { NormalizedTicketWithMessages } from '@/channels/_lib/types';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import { authorizeApiRoute } from '@/lib/auth/api-auth';
import { runFirstResponseFlow } from '@/lib/first-response/orchestrator';
import { ingestPullItem } from '@/lib/sync/ingest-pull-item';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * 楽天 R-MessE 専用 cron (5 分間隔)
 *
 * 設計レビュー: Gemini APPROVE (2026-05-07)
 *
 * 流れ (1 サイクル):
 *   1. code='rakuten' AND status='active' な channels を loop
 *   2. 各 channel について:
 *      a. fetchInbox (受信): tickets/messages upsert + channel_sync_state 更新
 *      b. sendApprovedDrafts (送信): ticket_drafts.status='approved' を最大 20 件送信
 *
 * 認可: `Authorization: Bearer ${CRON_SECRET}` または `X-Diag-Token: ${DIAG_TOKEN}`
 *      (既存 sync-channels と同パターン)
 *
 * 既存 /api/cron/sync-channels は楽天を除外する形で並走 (orchestrator 側でフィルタ)。
 */

function makeLogger(prefix: string): AdapterLogger {
  const fmt = (extra?: Record<string, unknown>) =>
    extra ? ` ${JSON.stringify(extra)}` : '';
  return {
    info: (msg, extra) => console.log(`[${prefix}] ${msg}${fmt(extra)}`),
    warn: (msg, extra) => console.warn(`[${prefix}] ${msg}${fmt(extra)}`),
    error: (msg, extra) => console.error(`[${prefix}] ${msg}${fmt(extra)}`),
  };
}

interface RakutenChannelRow {
  id: string;
  code: string;
  config: Record<string, unknown> | null;
}

async function loadActiveRakutenChannels(): Promise<RakutenChannelRow[]> {
  const supa = await getSupabaseAdmin();
  const { data, error } = await supa
    .from('channels')
    .select('id, code, config')
    .eq('status', 'active')
    .eq('code', 'rakuten');
  if (error) throw new Error(`loadActiveRakutenChannels failed: ${error.message}`);
  return (data ?? []) as RakutenChannelRow[];
}

async function loadSyncState(channelId: string): Promise<Date | null> {
  const supa = await getSupabaseAdmin();
  const { data, error } = await supa
    .from('channel_sync_state')
    .select('last_synced_at')
    .eq('channel_id', channelId)
    .maybeSingle();
  if (error) throw new Error(`loadSyncState failed: ${error.message}`);
  return data?.last_synced_at ? new Date(data.last_synced_at) : null;
}

async function persistSyncState(
  channelId: string,
  lastSyncedAt: Date,
  lastExternalId: string | undefined,
): Promise<void> {
  const supa = await getSupabaseAdmin();
  const { error } = await supa.from('channel_sync_state').upsert(
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
): Promise<{ id: string; isNew: boolean }> {
  // Gemini code review High 指摘: 旧 select→insert パターンは並行 cron 実行時に
  // unique 制約違反を起こすレース条件を含むため、(channel_id, external_id) UNIQUE を
  // 利用した atomic な .upsert() に切替。
  // ただし「既存の status を踏み潰さない」要件があるため、まず存在確認 + 既存行は
  // status を除外して update、未存在は upsert (再 select) の二段構成。
  // single-process cron が前提だが、二重起動への防御として onConflict を採用。
  const supa = await getSupabaseAdmin();
  const { data: existing, error: selErr } = await supa
    .from('tickets')
    .select('id, status')
    .eq('channel_id', channelId)
    .eq('external_id', payload.externalId)
    .maybeSingle();
  if (selErr) throw new Error(`upsertTicket(select) failed: ${selErr.message}`);

  // subject は **書かない** (codex CONCERN#1: 書込口は resolveAndPersistSubject に収束)。
  const baseUpdate = {
    customer_name: payload.customerName ?? null,
    customer_email: payload.customerEmail ?? null,
    channel_meta: payload.channelMeta ?? {},
    resolved_at: payload.resolvedAt ?? null,
  };

  if (existing) {
    const update = {
      ...baseUpdate,
      // untouched → done のみ自動遷移を許可。in_progress は人手フローを尊重して踏み潰さない。
      ...(existing.status === 'untouched' && payload.status === 'done'
        ? { status: 'done' }
        : {}),
    };
    const { error: updErr } = await supa.from('tickets').update(update).eq('id', existing.id);
    if (updErr) throw new Error(`upsertTicket(update) failed: ${updErr.message}`);
    return { id: existing.id as string, isNew: false };
  }

  // 競合した insert で並行 cron が同時に到達した場合のレース対策として
  // .upsert(..., onConflict) を使い、衝突時は無視 (ignoreDuplicates=true) → 後続 select で id を取得
  const { error: upErr } = await supa.from('tickets').upsert(
    {
      channel_id: channelId,
      external_id: payload.externalId,
      ...baseUpdate,
      status: payload.status,
    },
    { onConflict: 'channel_id,external_id', ignoreDuplicates: true },
  );
  if (upErr) throw new Error(`upsertTicket(upsert) failed: ${upErr.message}`);

  const { data: postSel, error: postErr } = await supa
    .from('tickets')
    .select('id')
    .eq('channel_id', channelId)
    .eq('external_id', payload.externalId)
    .single();
  if (postErr) throw new Error(`upsertTicket(post-select) failed: ${postErr.message}`);
  // existing が無く upsert を通った = 新規 (ignoreDuplicates により別 cron が先行した
  // 場合は実質既存だが、後段フローは DB partial UNIQUE + flag gate で冪等なので問題ない)
  return { id: postSel.id as string, isNew: true };
}

interface InboundResult {
  channelId: string;
  ticketsProcessed: number;
  messagesUpserted: number;
  error?: string;
}

async function runRakutenInbound(channel: RakutenChannelRow): Promise<InboundResult> {
  const logger = makeLogger(`rakuten-sync:inbound:${channel.code}`);
  const startedAt = new Date();

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
  let lastExternalId: string | undefined;
  let errorMessage: string | undefined;

  const supa = await getSupabaseAdmin();
  // message insert 失敗 (非23505) を観測したら cursor を進めない (codex PR review P3-redux):
  // 時刻ベース cursor を進めると失敗 message が次 sync の fromDate 窓から外れてロストするため。
  let holdCursor = false;

  try {
    for await (const item of rakutenAdapter.fetchInbox(ctx)) {
      const { id: ticketId, isNew } = await upsertTicket(channel.id, item.ticket);
      // 共通後処理: 新規 inbound 識別 → 件名(resolver が空時のみ要約)。楽天は auto-draft を使わず
      // first-response flow 経路を維持するため autoDraft:false (回帰回避)。
      const ingest = await ingestPullItem(supa, {
        channelId: channel.id,
        ticketId,
        messages: item.messages,
        channelMeta: item.ticket.channelMeta,
        customerName: item.ticket.customerName ?? null,
        autoDraft: false,
      });
      ticketsProcessed += 1;
      messagesUpserted += ingest.inserted;
      lastExternalId = item.ticket.externalId;
      if (ingest.warnings.length > 0) {
        logger.warn('pull_item_warnings', { ticketId, warnings: ingest.warnings });
      }
      if (ingest.messageErrorCount > 0) {
        holdCursor = true;
        logger.error('message_insert_error_holding_cursor', {
          ticketId,
          messageErrorCount: ingest.messageErrorCount,
        });
      }

      // 新規 ticket → 営業時間外一次返信フロー (flag-off 時は disabled で即 return)。
      // gate (codex PR review): 新規 ticket かつ **inbound message が実際に insert され
      // (newInboundCount>0)、かつ当該 ticket に message insert 失敗が無い (messageErrorCount===0)**
      // ときのみ発火する。空/部分 thread で first-response が走り、partial-unique により後で
      // 正しい本文で再生成されない事態 (空 thread 発火) を防ぐ。
      // sync 本体を絶対に壊さないため try/catch で隔離。送信可否は orchestrator 内の
      // flag/営業時間/source ガードに委譲 (flag-off で送信されない)。
      if (isNew && ingest.newInboundCount > 0 && ingest.messageErrorCount === 0) {
        try {
          const outcome = await runFirstResponseFlow(supa, ticketId);
          if (outcome.status !== 'disabled' && outcome.status !== 'within_hours') {
            logger.info('first_response.outcome', {
              ticketId,
              status: outcome.status,
              category: outcome.category,
              sendResult: outcome.sendResult,
            });
          }
        } catch (err) {
          logger.warn('first_response_failed_continuing', {
            ticketId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // per-ticket の wall-clock cursor persist は廃止 (codex PR review: 途中 persist が後続
      // 失敗で巻き戻せず取りこぼす)。cursor は run 完全成功時に finalize で 1 回だけ進める。
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    logger.error('fetchInbox_failed', { error: errorMessage });
  }

  // message insert 失敗があれば error として可視化し finalize しない = cursor 保持。
  if (holdCursor && !errorMessage) {
    errorMessage = 'message_insert_error: cursor held for retry next sync';
  }

  if (!errorMessage) {
    try {
      await persistSyncState(channel.id, startedAt, lastExternalId);
    } catch (err) {
      // per-ticket persist 廃止後はこれが唯一の cursor 前進。失敗を握ると cursor が進まないまま
      // success 応答になり cursor stuck を黙殺する (codex PR review)。channel error として可視化。
      errorMessage = `persistSyncState_finalize_failed: ${err instanceof Error ? err.message : String(err)}`;
      logger.error('persistSyncState_finalize_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    channelId: channel.id,
    ticketsProcessed,
    messagesUpserted,
    error: errorMessage,
  };
}

export async function GET(req: NextRequest) {
  const authError = authorizeApiRoute(req, { tier: 'cron' });
  if (authError) return authError;

  const startedAt = new Date();
  try {
    const channels = await loadActiveRakutenChannels();
    const results: Array<{
      channelId: string;
      channelCode: string;
      inbound: InboundResult;
      outbound: { attempted: number; succeeded: number; failed: number };
      error?: string;
    }> = [];

    for (const ch of channels) {
      let inbound: InboundResult = {
        channelId: ch.id,
        ticketsProcessed: 0,
        messagesUpserted: 0,
      };
      let outbound = { attempted: 0, succeeded: 0, failed: 0 };
      let channelError: string | undefined;

      try {
        inbound = await runRakutenInbound(ch);
        const out = await sendApprovedDrafts(ch, makeLogger(`rakuten-sync:outbound:${ch.code}`));
        outbound = { attempted: out.attempted, succeeded: out.succeeded, failed: out.failed };
      } catch (err) {
        channelError = err instanceof Error ? err.message : String(err);
      }

      results.push({
        channelId: ch.id,
        channelCode: ch.code,
        inbound,
        outbound,
        error: channelError ?? inbound.error,
      });
    }

    const hasError = results.some((r) => r.error);
    return NextResponse.json(
      {
        ok: !hasError,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        channels: results,
      },
      { status: hasError ? 207 : 200 },
    );
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message ?? String(err) },
      { status: 500 },
    );
  }
}

export const POST = GET;
