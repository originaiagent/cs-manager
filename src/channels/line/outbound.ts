/**
 * LINE Messaging API 送信 (返信) adapter
 *
 * 設計レビュー: codex APPROVE (2026-06-25, 3 ラウンド) — docs/design/line-reply-wiring.md
 *
 * 流れ (送信専用 cron `/api/cron/line-sync` から channel 単位で呼ぶ):
 *   0. stale 'sending' 再回収 (15min<経過≤24h→approved / >24h→failed。retry-key 窓 24h 整合)
 *   1. ticket_drafts WHERE status='approved' ∧ ticket.channel_id=<line> ∧ SEND_SAFE_OR_FILTER を最大 N 件「候補抽出」
 *   2. atomic claim: approved→sending (status='approved' ガードで並行 cron との二重送信を排他)
 *   3. claim した各 draft:
 *      a. 宛先 userId (ticket.channel_meta.userId) を検証。無ければ failed (group/room 等は push 不能)
 *      b. POST /bot/message/push (X-Line-Retry-Key=draftId で LINE 側も冪等)。429-ratelimit/5xx は backoff
 *      c. 結果分類 (classifyLineSend):
 *         - sent (2xx/409)   → status='sent' + sent_at + external_message_id、messages へ outbound upsert
 *         - permanent(4xx≠429 / 429-monthly) → status='failed' + last_error (再送しない)
 *         - transient(429-ratelimit/5xx/network) → status='approved' に戻す + last_error (次 cron で再送)
 *   4. 1 サイクル最大 MAX_SENDS_PER_RUN 件 (Vercel タイムアウト対策)
 *
 * 認証: Core /api/credentials/line_messaging?scope_key=<Channel ID> 経由 (鍵ハードコード禁止)。
 * 宛先: 受信時に保存した ticket.channel_meta.userId。reply token は承認遅延で失効するため push 一択。
 */

import { getCredential } from '@/lib/credentials';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import type { AdapterLogger } from '../_lib/adapter';
import { formatChannelMessageId } from '../_lib/ids';
// SEND_SAFE_OR_FILTER / OutboundResult は楽天モジュールの正を共有 (重複定義しない)。
import { SEND_SAFE_OR_FILTER, type OutboundResult } from '../rakuten/outbound';
import type { LineCredentials } from './auth';
import { LineMessagingClient, classifyLineSend } from './client';
import { LineTransportError, type LinePushResult } from './types';

const MAX_SENDS_PER_RUN = 20;
const REQUEST_DELAY_MS = 200;
const BACKOFF_SCHEDULE_MS = [1000, 2000, 4000];
/** 'sending' を再送可能に戻す閾値 (これ未満は別 cron 進行中とみなし触らない)。 */
const STALE_RECLAIM_MS = 15 * 60 * 1000;
/** X-Line-Retry-Key の LINE 側重複防止窓。これを超えた 'sending' の自動再送は二重配信リスク。 */
const RETRY_KEY_EXPIRY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_LINE_CRED_SERVICE_CODE = 'line_messaging';
/** config 改竄で他サービスの鍵を引かせない多層防御 (受信 route と同趣旨)。 */
const ALLOWED_LINE_SERVICE_CODES = new Set<string>([DEFAULT_LINE_CRED_SERVICE_CODE]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface LineChannelRow {
  id: string;
  code: string;
  config: Record<string, unknown> | null;
}

/** claim 済みで送信対象の draft (DB 非依存の素データ)。 */
export interface ClaimedLineDraft {
  id: string;
  body: string;
  ticketId: string;
  /** ticket.channel_meta.userId の生値 (push 宛先候補。未検証)。 */
  toUserId: string | null;
}

// ---------------------------------------------------------------------------
// 純関数 (テスト容易性のため export)
// ---------------------------------------------------------------------------

/** push 宛先として使える userId か (LINE の 1:1 user は 'U' 始まり。group 'C'/room 'R' は対象外)。 */
export function isValidPushUserId(userId: string | null | undefined): userId is string {
  return typeof userId === 'string' && userId.length >= 2 && userId.startsWith('U');
}

/** channel_meta から userId 生値を取り出す (無ければ null)。 */
export function extractRawUserId(channelMeta: unknown): string | null {
  if (channelMeta && typeof channelMeta === 'object') {
    const v = (channelMeta as Record<string, unknown>).userId;
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * external_message_id を組み立てる (純関数)。
 * 優先: sentMessages[0].id > (409: x-line-accepted-request-id) > (2xx: x-line-request-id) > draftId fallback。
 * x-line-request-id は再試行リクエスト側 ID なので配送識別子としては弱く、409 では accepted を優先する。
 */
export function buildExternalMessageId(result: LinePushResult, draftId: string): string {
  if (result.sentMessageId) return `line:${result.sentMessageId}`;
  if (result.status === 409) {
    return result.acceptedRequestId
      ? `line-accepted:${result.acceptedRequestId}`
      : `line-retry-conflict:${draftId}`;
  }
  return result.requestId ? `line-req:${result.requestId}` : `line-sent:${draftId}`;
}

// ---------------------------------------------------------------------------
// Repository (DB 入出力を分離し、orchestration を fake repo で unit テスト可能にする)
// ---------------------------------------------------------------------------

export interface LineDraftRepo {
  /** 起動時の stale 'sending' 再回収 (15min<経過≤24h→approved / >24h→failed)。 */
  reclaimStaleSending(channelId: string): Promise<{ released: number; failed: number }>;
  /** approved を atomic に claim (approved→sending) し、claim できた draft のみ返す。 */
  claimApprovedDrafts(channelId: string, limit: number): Promise<ClaimedLineDraft[]>;
  markSent(draftId: string, externalMessageId: string, sentAtIso: string): Promise<void>;
  markFailed(draftId: string, error: string): Promise<void>;
  /** transient 失敗。再送可能に approved へ戻す。 */
  releaseToApproved(draftId: string, error: string): Promise<void>;
  upsertOutboundMessage(
    ticketId: string,
    channelMessageId: string,
    body: string,
    sentAtIso: string,
  ): Promise<void>;
}

interface CandidateRow {
  ticketId: string;
  body: string;
  channelMeta: unknown;
}

class SupabaseLineDraftRepo implements LineDraftRepo {
  async reclaimStaleSending(channelId: string): Promise<{ released: number; failed: number }> {
    const supa = await getSupabaseAdmin();
    const { data, error } = await supa
      .from('ticket_drafts')
      .select('id, updated_at, ticket:tickets!inner(channel_id)')
      .eq('status', 'sending')
      .eq('ticket.channel_id', channelId);
    if (error) throw new Error(`reclaimStaleSending(select) failed: ${error.message}`);

    const now = Date.now();
    const releaseIds: string[] = [];
    const failIds: string[] = [];
    for (const row of (data ?? []) as Array<{ id: string; updated_at: string }>) {
      const ageMs = now - new Date(row.updated_at).getTime();
      if (!Number.isFinite(ageMs)) continue;
      if (ageMs > RETRY_KEY_EXPIRY_MS) failIds.push(row.id);
      else if (ageMs > STALE_RECLAIM_MS) releaseIds.push(row.id);
    }

    if (releaseIds.length > 0) {
      const { error: relErr } = await supa
        .from('ticket_drafts')
        .update({
          status: 'approved',
          updated_at: new Date().toISOString(),
          last_error: 'line: reclaimed stale sending (>15m, retry-key still valid)',
        })
        .in('id', releaseIds);
      if (relErr) throw new Error(`reclaimStaleSending(release) failed: ${relErr.message}`);
    }
    if (failIds.length > 0) {
      const { error: failErr } = await supa
        .from('ticket_drafts')
        .update({
          status: 'failed',
          last_error: 'line: sending stale >24h (retry-key expired, manual review)',
        })
        .in('id', failIds);
      if (failErr) throw new Error(`reclaimStaleSending(fail) failed: ${failErr.message}`);
    }
    return { released: releaseIds.length, failed: failIds.length };
  }

  async claimApprovedDrafts(channelId: string, limit: number): Promise<ClaimedLineDraft[]> {
    const supa = await getSupabaseAdmin();
    // 1. 候補抽出 (channel + 送信安全フィルタ)
    const { data, error } = await supa
      .from('ticket_drafts')
      .select('id, body, ticket_id, ticket:tickets!inner(id, channel_id, channel_meta)')
      .eq('status', 'approved')
      .eq('ticket.channel_id', channelId)
      .or(SEND_SAFE_OR_FILTER)
      .order('created_at', { ascending: true })
      .limit(limit);
    if (error) throw new Error(`claimApprovedDrafts(select) failed: ${error.message}`);

    const byId = new Map<string, CandidateRow>();
    for (const row of (data ?? []) as any[]) {
      const ticket = Array.isArray(row.ticket) ? row.ticket[0] : row.ticket;
      if (!ticket) continue;
      byId.set(row.id as string, {
        ticketId: row.ticket_id as string,
        body: row.body as string,
        channelMeta: ticket.channel_meta ?? null,
      });
    }
    const candidateIds = [...byId.keys()];
    if (candidateIds.length === 0) return [];

    // 2. atomic claim: status='approved' ガードが排他の本体。
    const { data: claimed, error: claimErr } = await supa
      .from('ticket_drafts')
      .update({ status: 'sending', updated_at: new Date().toISOString() })
      .in('id', candidateIds)
      .eq('status', 'approved')
      .select('id, body');
    if (claimErr) throw new Error(`claimApprovedDrafts(claim) failed: ${claimErr.message}`);

    return ((claimed ?? []) as Array<{ id: string; body: string }>).map((r) => {
      const meta = byId.get(r.id);
      return {
        id: r.id,
        body: r.body,
        ticketId: meta?.ticketId ?? '',
        toUserId: extractRawUserId(meta?.channelMeta),
      };
    });
  }

  async markSent(draftId: string, externalMessageId: string, sentAtIso: string): Promise<void> {
    const supa = await getSupabaseAdmin();
    const { error } = await supa
      .from('ticket_drafts')
      .update({ status: 'sent', sent_at: sentAtIso, external_message_id: externalMessageId, last_error: null })
      .eq('id', draftId);
    if (error) throw new Error(`markSent failed: ${error.message}`);
  }

  async markFailed(draftId: string, errorMsg: string): Promise<void> {
    const supa = await getSupabaseAdmin();
    const { error } = await supa
      .from('ticket_drafts')
      .update({ status: 'failed', last_error: errorMsg.slice(0, 1000) })
      .eq('id', draftId);
    if (error) throw new Error(`markFailed failed: ${error.message}`);
  }

  async releaseToApproved(draftId: string, errorMsg: string): Promise<void> {
    const supa = await getSupabaseAdmin();
    const { error } = await supa
      .from('ticket_drafts')
      .update({ status: 'approved', updated_at: new Date().toISOString(), last_error: errorMsg.slice(0, 1000) })
      .eq('id', draftId);
    if (error) throw new Error(`releaseToApproved failed: ${error.message}`);
  }

  async upsertOutboundMessage(
    ticketId: string,
    channelMessageId: string,
    body: string,
    sentAtIso: string,
  ): Promise<void> {
    const supa = await getSupabaseAdmin();
    const { error } = await supa.from('messages').upsert(
      {
        ticket_id: ticketId,
        channel_message_id: channelMessageId,
        direction: 'outbound',
        body,
        sender_name: null,
        sent_at: sentAtIso,
        attachments: [],
      },
      { onConflict: 'ticket_id,channel_message_id' },
    );
    if (error) throw new Error(`upsertOutboundMessage failed: ${error.message}`);
  }
}

/**
 * transient (429-ratelimit / 5xx / network) のみ backoff リトライ。同一 retryKey で再送するため
 * LINE 側でも重複配信は起きない。permanent / sent はそのまま返す。
 */
async function pushWithBackoff(
  client: LineMessagingClient,
  args: { to: string; text: string; retryKey: string },
): Promise<LinePushResult> {
  for (let attempt = 0; ; attempt += 1) {
    let result: LinePushResult;
    try {
      result = await client.pushMessage(args);
    } catch (err) {
      if (err instanceof LineTransportError && attempt < BACKOFF_SCHEDULE_MS.length) {
        await sleep(BACKOFF_SCHEDULE_MS[attempt]);
        continue;
      }
      throw err;
    }
    const outcome = classifyLineSend(result.status, result.rawBody);
    if (outcome === 'transient' && attempt < BACKOFF_SCHEDULE_MS.length) {
      await sleep(BACKOFF_SCHEDULE_MS[attempt]);
      continue;
    }
    return result;
  }
}

export interface SendApprovedLineDraftsDeps {
  repo?: LineDraftRepo;
  client?: LineMessagingClient;
}

/**
 * approved な LINE 返信ドラフトを push 送信する。
 * cron / テストから呼ぶ。deps を渡せば DB / LINE client を差し替え可能 (unit テスト用)。
 */
export async function sendApprovedLineDrafts(
  channel: LineChannelRow,
  logger: AdapterLogger,
  deps: SendApprovedLineDraftsDeps = {},
): Promise<OutboundResult> {
  const cfg = (channel.config ?? {}) as Record<string, unknown>;

  const serviceCode =
    typeof cfg.service_code === 'string' && cfg.service_code.trim()
      ? cfg.service_code.trim()
      : DEFAULT_LINE_CRED_SERVICE_CODE;
  if (!ALLOWED_LINE_SERVICE_CODES.has(serviceCode)) {
    throw new Error(`line.outbound: service_code '${serviceCode}' not in allowlist (channel_id=${channel.id})`);
  }
  const scopeKey =
    typeof cfg.scope_key === 'string' && cfg.scope_key.trim() ? cfg.scope_key.trim() : null;

  let client = deps.client;
  if (!client) {
    const credResp = await getCredential<LineCredentials>(serviceCode, scopeKey);
    client = new LineMessagingClient({ credentials: credResp.credentials });
  }
  const repo = deps.repo ?? new SupabaseLineDraftRepo();

  // 0. stale 'sending' 再回収
  try {
    const reclaimed = await repo.reclaimStaleSending(channel.id);
    if (reclaimed.released > 0 || reclaimed.failed > 0) {
      logger.info('line.outbound.reclaim', { channelId: channel.id, ...reclaimed });
    }
  } catch (err) {
    // 再回収失敗は送信本体を止めない (次 cron で再試行)。
    logger.warn('line.outbound.reclaim_failed', {
      channelId: channel.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 1+2. 候補抽出 + atomic claim
  const drafts = await repo.claimApprovedDrafts(channel.id, MAX_SENDS_PER_RUN);
  logger.info('line.outbound.start', { channelId: channel.id, claimed: drafts.length });

  const errors: Array<{ draftId: string; error: string }> = [];
  let succeeded = 0;
  let failed = 0;

  for (const draft of drafts) {
    try {
      // 3a. 宛先検証
      if (!isValidPushUserId(draft.toUserId)) {
        await repo.markFailed(draft.id, 'line: no usable userId to push (group/room or missing)');
        failed += 1;
        logger.warn('line.outbound.no_user', { draftId: draft.id });
        continue;
      }

      // 3b. push (retryKey=draftId)
      const result = await pushWithBackoff(client, {
        to: draft.toUserId,
        text: draft.body,
        retryKey: draft.id,
      });
      const outcome = classifyLineSend(result.status, result.rawBody);

      // 3c. 分類して状態遷移
      if (outcome === 'sent') {
        const sentAt = new Date().toISOString();
        const externalMessageId = buildExternalMessageId(result, draft.id);
        await repo.markSent(draft.id, externalMessageId, sentAt);
        await repo.upsertOutboundMessage(
          draft.ticketId,
          formatChannelMessageId('line-reply', draft.id),
          draft.body,
          sentAt,
        );
        succeeded += 1;
        logger.info('line.outbound.sent', {
          draftId: draft.id,
          status: result.status,
          externalMessageId,
        });
      } else if (outcome === 'permanent') {
        const msg = `line push permanent ${result.status}: ${result.rawBody.slice(0, 300)}`;
        await repo.markFailed(draft.id, msg);
        failed += 1;
        errors.push({ draftId: draft.id, error: msg });
        logger.error('line.outbound.failed_permanent', { draftId: draft.id, status: result.status });
      } else {
        // transient: 次 cron で再送
        const msg = `line push transient ${result.status}: ${result.rawBody.slice(0, 300)}`;
        await repo.releaseToApproved(draft.id, msg);
        failed += 1;
        errors.push({ draftId: draft.id, error: msg });
        logger.warn('line.outbound.transient_retry_later', { draftId: draft.id, status: result.status });
      }
    } catch (err) {
      // LineTransportError (backoff 尽き) or DB エラー → transient 扱いで approved に戻す
      failed += 1;
      const errMsg = err instanceof Error ? err.message : String(err);
      errors.push({ draftId: draft.id, error: errMsg });
      try {
        await repo.releaseToApproved(draft.id, `line push exception: ${errMsg}`);
      } catch (relErr) {
        logger.error('line.outbound.release_failed', {
          draftId: draft.id,
          error: relErr instanceof Error ? relErr.message : String(relErr),
        });
      }
      logger.error('line.outbound.exception', { draftId: draft.id, error: errMsg });
    }
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
