/**
 * 楽天 R-MessE 送信 (回答返信) adapter
 *
 * 設計レビュー: Gemini APPROVE (2026-05-07)
 *
 * 流れ:
 *   1. ticket_drafts WHERE status='approved' AND ticket.channel_id=<rakuten> を最大 N 件取得
 *   2. 各 draft について:
 *      a. POST /inquiry/reply (200ms スリープ + 429 で exponential backoff)
 *      b. **POST 成功直後に** ticket_drafts.status='sent', sent_at=now,
 *         external_message_id=regDate fallback を設定 (二重送信防止: ID 取得前にコミット)
 *      c. 続けて GET /inquiry/{inquiryNumber} を 1 回叩き、replies[] を regDate + body 一致で
 *         特定し external_message_id を本物の reply.id に上書き (失敗しても OK)
 *      d. messages テーブルに outbound message を upsert
 *   3. 1 サイクルあたり最大 MAX_SENDS_PER_RUN 件で打ち切り (Vercel タイムアウト対策)
 */

import { getCredential } from '@/lib/credentials';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import type { AdapterLogger } from '../_lib/adapter';
import { formatChannelMessageId } from '../_lib/ids';
import type { RakutenCredentials } from './auth';
import { RakutenApiError, RakutenInquiryClient } from './client';
import type { RakutenReplyRequest, RakutenReplyResponse } from './types';

const MAX_SENDS_PER_RUN = 20;
const REQUEST_DELAY_MS = 200;
const BACKOFF_SCHEDULE_MS = [1000, 2000, 4000];

interface RakutenChannelRow {
  id: string;
  code: string;
  config: Record<string, unknown> | null;
}

interface DraftWithTicket {
  id: string;
  body: string;
  ticket_id: string;
  ticket: {
    id: string;
    external_id: string;
    channel_id: string;
  };
}

export interface OutboundResult {
  channelId: string;
  channelCode: string;
  attempted: number;
  succeeded: number;
  failed: number;
  errors: Array<{ draftId: string; error: string }>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function asStr(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

async function loadApprovedDrafts(
  channelId: string,
  limit: number,
): Promise<DraftWithTicket[]> {
  const supa = await getSupabaseAdmin();
  const { data, error } = await supa
    .from('ticket_drafts')
    .select('id, body, ticket_id, ticket:tickets!inner(id, external_id, channel_id)')
    .eq('status', 'approved')
    .eq('ticket.channel_id', channelId)
    // 送信安全フィルタ (構造保証): 送信可能なのは
    //   source IN ('manual','first_response')  (オペレータ入力 / テンプレ)
    //   OR is_separated = true                 (split-reply で分離した顧客向け本文のみ)
    // のみ。旧 ai_draft/rag (is_separated=false = 混在の可能性) は承認済でも送信しない。
    .or('source.in.(manual,first_response),is_separated.eq.true')
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) throw new Error(`loadApprovedDrafts failed: ${error.message}`);
  // Supabase の relation 結合は配列で返ることがあるため、単一に正規化
  return ((data ?? []) as any[])
    .map((row) => {
      const ticket = Array.isArray(row.ticket) ? row.ticket[0] : row.ticket;
      if (!ticket) return null;
      return {
        id: row.id as string,
        body: row.body as string,
        ticket_id: row.ticket_id as string,
        ticket: {
          id: ticket.id as string,
          external_id: ticket.external_id as string,
          channel_id: ticket.channel_id as string,
        },
      };
    })
    .filter((x): x is DraftWithTicket => x !== null);
}

async function markDraftSent(
  draftId: string,
  externalMessageId: string,
  sentAt: string,
): Promise<void> {
  const supa = await getSupabaseAdmin();
  const { error } = await supa
    .from('ticket_drafts')
    .update({
      status: 'sent',
      sent_at: sentAt,
      external_message_id: externalMessageId,
      last_error: null,
    })
    .eq('id', draftId);
  if (error) throw new Error(`markDraftSent failed: ${error.message}`);
}

async function updateDraftExternalMessageId(
  draftId: string,
  externalMessageId: string,
): Promise<void> {
  const supa = await getSupabaseAdmin();
  const { error } = await supa
    .from('ticket_drafts')
    .update({ external_message_id: externalMessageId })
    .eq('id', draftId);
  if (error) throw new Error(`updateDraftExternalMessageId failed: ${error.message}`);
}

async function recordDraftError(draftId: string, message: string): Promise<void> {
  const supa = await getSupabaseAdmin();
  const { error } = await supa
    .from('ticket_drafts')
    .update({ last_error: message.slice(0, 1000) })
    .eq('id', draftId);
  // last_error 更新失敗は致命的ではないので throw しない
  if (error) console.warn(`recordDraftError failed: ${error.message}`);
}

async function upsertOutboundMessage(
  ticketId: string,
  channelMessageId: string,
  body: string,
  sentAt: string,
): Promise<void> {
  const supa = await getSupabaseAdmin();
  const { error } = await supa.from('messages').upsert(
    {
      ticket_id: ticketId,
      channel_message_id: channelMessageId,
      direction: 'outbound',
      body,
      sender_name: null,
      sent_at: sentAt,
      attachments: [],
    },
    { onConflict: 'ticket_id,channel_message_id' },
  );
  if (error) throw new Error(`upsertOutboundMessage failed: ${error.message}`);
}

/**
 * 429 (rate limit) を exponential backoff で 3 回までリトライ。
 * その他のエラーは即 throw。
 */
async function sendReplyWithBackoff(
  client: RakutenInquiryClient,
  req: RakutenReplyRequest,
): Promise<RakutenReplyResponse> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await client.sendReply(req);
    } catch (err) {
      if (
        err instanceof RakutenApiError &&
        err.status === 429 &&
        attempt < BACKOFF_SCHEDULE_MS.length
      ) {
        await sleep(BACKOFF_SCHEDULE_MS[attempt]);
        continue;
      }
      throw err;
    }
  }
}

/**
 * POST /inquiry/reply 直後に GET /inquiry/{inquiryNumber} を叩き、replies[] から
 * 送信したメッセージに対応する reply.id を返す。
 * 一致条件: regDate と body の両方が一致する最新 reply (Gemini レビュー指摘:
 * 同一秒投稿時の誤特定リスク低減のため body も照合)。
 *
 * 失敗時は null を返す (caller は regDate fallback を維持)。
 */
async function resolveExternalMessageId(
  client: RakutenInquiryClient,
  inquiryNumber: string,
  expectedBody: string,
  expectedRegDate: string,
  logger: AdapterLogger,
): Promise<string | null> {
  try {
    const resp = await client.getInquiry(inquiryNumber);
    const replies = resp.result.replies ?? [];
    // regDate 文字列の前方一致 + body 一致 (regDate は秒精度なので完全一致を要件にしない)
    const match = [...replies]
      .reverse()
      .find(
        (r) =>
          (r.message ?? '') === expectedBody &&
          typeof r.regDate === 'string' &&
          r.regDate.startsWith(expectedRegDate.slice(0, 19)),
      );
    if (!match || match.id === undefined) return null;
    return String(match.id);
  } catch (err) {
    logger.warn('rakuten.outbound.resolveExternalMessageId_failed', {
      inquiryNumber,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function sendApprovedDrafts(
  channel: RakutenChannelRow,
  logger: AdapterLogger,
): Promise<OutboundResult> {
  const cfg = channel.config ?? {};
  const apiBase = asStr(
    (cfg as Record<string, unknown>).api_base,
    'https://api.rms.rakuten.co.jp/es/1.0/inquirymng-api',
  );
  const shopId = asStr((cfg as Record<string, unknown>).shop_id, '');
  if (!shopId) {
    throw new Error(
      `rakuten.outbound: channels.config.shop_id is required (channel_id=${channel.id})`,
    );
  }

  const credResp = await getCredential<RakutenCredentials>('rakuten_rmesse', shopId);
  const client = new RakutenInquiryClient({ apiBase, credentials: credResp.credentials });

  const drafts = await loadApprovedDrafts(channel.id, MAX_SENDS_PER_RUN);
  logger.info('rakuten.outbound.start', { channelId: channel.id, drafts: drafts.length });

  const errors: Array<{ draftId: string; error: string }> = [];
  let succeeded = 0;
  let failed = 0;

  for (const draft of drafts) {
    try {
      const replyRes = await sendReplyWithBackoff(client, {
        inquiryNumber: draft.ticket.external_id,
        shopId,
        message: draft.body,
      });
      const regDate = replyRes.result.regDate;
      const sentAt = parseRegDateToIso(regDate);

      // (Gemini 指摘: 二重送信防止) POST 成功 → 即 DB status=sent + 暫定 external_message_id
      const provisionalExternalId = `regdate:${regDate}`;
      await markDraftSent(draft.id, provisionalExternalId, sentAt);
      await upsertOutboundMessage(
        draft.ticket_id,
        formatChannelMessageId('reply-pending', draft.id),
        draft.body,
        sentAt,
      );

      // ID 取得 try (失敗しても暫定値が残る)
      const realId = await resolveExternalMessageId(
        client,
        draft.ticket.external_id,
        draft.body,
        regDate,
        logger,
      );
      if (realId) {
        await updateDraftExternalMessageId(draft.id, realId);
      }

      succeeded += 1;
      logger.info('rakuten.outbound.sent', {
        draftId: draft.id,
        inquiryNumber: draft.ticket.external_id,
        externalMessageId: realId ?? provisionalExternalId,
      });
    } catch (err) {
      failed += 1;
      const errMsg = err instanceof Error ? err.message : String(err);
      errors.push({ draftId: draft.id, error: errMsg });
      await recordDraftError(draft.id, errMsg);
      logger.error('rakuten.outbound.failed', { draftId: draft.id, error: errMsg });
    }
    // レート制限 60req/min 対応: send 1 件ごとに 200ms スリープ
    await sleep(REQUEST_DELAY_MS);
  }

  return {
    channelId: channel.id,
    channelCode: channel.code,
    attempted: drafts.length,
    succeeded,
    failed,
    errors,
  };
}

function parseRegDateToIso(regDate: string): string {
  const hasTz = /[zZ]|[+-]\d\d:?\d\d$/.test(regDate);
  const normalized = hasTz ? regDate : `${regDate}+09:00`;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}
