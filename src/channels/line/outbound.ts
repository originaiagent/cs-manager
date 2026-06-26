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
  /** 既存の first_send_at (再 claim 時は設定済。null なら初回 push 前に stamp する)。 */
  firstSendAt: string | null;
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
 * channel_meta から「push してよい 1:1 ユーザーの userId」を解決する (純関数)。
 *
 * source.type='user' かつ userId が 1:1 形式 ('U' 始まり) の時のみ userId を返す。
 * group/room は sender の userId が入っていても 1:1 宛先ではない (private 誤送になる) ため null。
 * codex review P2: source.type を確認せず userId だけで push すると group/room の返信が
 * 送信者個人へ private 送信されてしまうのを防ぐ。
 */
export function resolvePushUserId(channelMeta: unknown): string | null {
  if (!channelMeta || typeof channelMeta !== 'object') return null;
  const meta = channelMeta as Record<string, unknown>;
  // **明示的に 1:1 provenance (sourceType='user') がある行のみ** push 宛先を解決する。
  // codex review P1: 旧 webhook は group/room も sender userId を channel_meta.userId に保存した。
  // sourceType 未設定 (legacy) を許容すると group 由来 draft を送信者個人へ private 誤送し得るため、
  // provenance 不明な行は許容せず null を返す (送信側で failed=隔離。誤送 > 取りこぼし回避)。
  // forward は inbound が 1:1 限定 ingest かつ sourceType='user' を必ず付与するので取りこぼさない。
  if (meta.sourceType !== 'user') return null;
  const userId = extractRawUserId(channelMeta);
  return isValidPushUserId(userId) ? userId : null;
}

/** retry-key (=draftId) の LINE 24h 重複防止窓が失効しているか (純関数)。失効後の再 push は二重配信になる。 */
export function isRetryKeyExpired(nowMs: number, firstSendAtMs: number | null): boolean {
  return firstSendAtMs != null && nowMs - firstSendAtMs > RETRY_KEY_EXPIRY_MS;
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

/**
 * stale 'sending' 行の扱いを決める (純関数)。
 *
 * codex review P2: 24h 終端は **first_send_at (不変)** を基準にする。updated_at は再 claim で
 * 毎回更新されるため、これを基準にすると再送ループが永久に >24h に到達せず retry-key 失効後に
 * 二重配信し得る。15分 stuck 検知は updated_at (最終活動) 基準のままでよい。
 *
 * - 最初の送信から 24h 超 → 'fail' (retry-key 失効。再送せず手動レビュー)
 * - それ未満で最終更新から 15分 超 → 'release' (in-flight が停止 → approved に戻し再送可)
 * - それ以外 → 'keep' (進行中とみなし触らない)
 */
export function classifyStaleSending(args: {
  nowMs: number;
  updatedAtMs: number;
  firstSendAtMs: number | null;
}): 'fail' | 'release' | 'keep' {
  const { nowMs, updatedAtMs, firstSendAtMs } = args;
  // first_send_at 未設定の旧行は updated_at で代替 (実運用では claim 時に必ず設定される)。
  const firstRef = firstSendAtMs ?? updatedAtMs;
  if (nowMs - firstRef > RETRY_KEY_EXPIRY_MS) return 'fail';
  if (nowMs - updatedAtMs > STALE_RECLAIM_MS) return 'release';
  return 'keep';
}

// ---------------------------------------------------------------------------
// Repository (DB 入出力を分離し、orchestration を fake repo で unit テスト可能にする)
// ---------------------------------------------------------------------------

export interface LineDraftRepo {
  /** 起動時の stale 'sending' 再回収 (15min<経過≤24h→approved / >24h→failed)。 */
  reclaimStaleSending(channelId: string): Promise<{ released: number; failed: number }>;
  /** approved を atomic に claim (approved→sending) し、claim できた draft のみ返す。 */
  claimApprovedDrafts(channelId: string, limit: number): Promise<ClaimedLineDraft[]>;
  /** first_send_at を「初回 push の直前」に 1 度だけ stamp する (claim 時ではない)。既設定なら no-op。 */
  markFirstSendAt(draftId: string): Promise<void>;
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
      .select('id, updated_at, first_send_at, ticket:tickets!inner(channel_id)')
      .eq('status', 'sending')
      .eq('ticket.channel_id', channelId);
    if (error) throw new Error(`reclaimStaleSending(select) failed: ${error.message}`);

    const now = Date.now();
    const releaseCutoffIso = new Date(now - STALE_RECLAIM_MS).toISOString(); // 15min 前 (updated_at 基準)
    const failCutoffIso = new Date(now - RETRY_KEY_EXPIRY_MS).toISOString(); // 24h 前 (first_send_at 基準)
    const releaseIds: string[] = [];
    const failIds: string[] = [];
    for (const row of (data ?? []) as Array<{
      id: string;
      updated_at: string;
      first_send_at: string | null;
    }>) {
      const updatedAtMs = new Date(row.updated_at).getTime();
      if (!Number.isFinite(updatedAtMs)) continue;
      const firstSendAtMs = row.first_send_at ? new Date(row.first_send_at).getTime() : null;
      const decision = classifyStaleSending({
        nowMs: now,
        updatedAtMs,
        firstSendAtMs: Number.isFinite(firstSendAtMs as number) ? firstSendAtMs : null,
      });
      if (decision === 'fail') failIds.push(row.id);
      else if (decision === 'release') releaseIds.push(row.id);
    }

    // codex review P1: id 限定だけだと、SELECT 後に別 cron が同一行を再 claim/送信した場合に
    // fresh な 'sending' / 'sent' 行を踏み潰し得る。UPDATE 側にも status='sending' を再ガードする。
    // release は updated_at<15min前、fail は first_send_at<24h前 を併せてガード (再 claim/送信済 を除外)。
    if (releaseIds.length > 0) {
      const { error: relErr } = await supa
        .from('ticket_drafts')
        .update({
          status: 'approved',
          updated_at: new Date().toISOString(),
          last_error: 'line: reclaimed stale sending (>15m, retry-key still valid)',
        })
        .in('id', releaseIds)
        .eq('status', 'sending')
        .lt('updated_at', releaseCutoffIso);
      if (relErr) throw new Error(`reclaimStaleSending(release) failed: ${relErr.message}`);
    }
    if (failIds.length > 0) {
      // first_send_at 基準で 24h 超 → terminal。first_send_at は不変なので再 claim されても誤らない。
      const failPayload = {
        status: 'failed',
        last_error: 'line: sending stale >24h since first_send_at (retry-key expired, manual review)',
      };
      // (a) first_send_at が設定済の行: first_send_at<24h前 をガード。
      const { error: failErr } = await supa
        .from('ticket_drafts')
        .update(failPayload)
        .in('id', failIds)
        .eq('status', 'sending')
        .lt('first_send_at', failCutoffIso);
      if (failErr) throw new Error(`reclaimStaleSending(fail) failed: ${failErr.message}`);
      // (b) first_send_at が NULL の行 (claim の first_send_at 設定が失敗した等の不整合): updated_at で
      //     代替判定。`.lt('first_send_at')` は NULL に match しないため別 update で救済し、sending に
      //     永久滞留させない。再 claim で first_send_at が付くと .is(null) から外れるので二重失敗しない。
      const { error: failNullErr } = await supa
        .from('ticket_drafts')
        .update(failPayload)
        .in('id', failIds)
        .eq('status', 'sending')
        .is('first_send_at', null)
        .lt('updated_at', failCutoffIso);
      if (failNullErr) throw new Error(`reclaimStaleSending(fail-null) failed: ${failNullErr.message}`);
    }

    // codex review P2: 'approved' だが first_send_at>24h の行 (transient 失敗を繰り返し approved に
    // 滞留したもの) も retry-key 失効済。再 claim/再 push すると LINE が重複排除できず二重配信になる。
    // claim 前に terminal 化する (claimApprovedDrafts の候補クエリでも除外するが二重防御)。
    const { data: expApproved, error: expSelErr } = await supa
      .from('ticket_drafts')
      .select('id, ticket:tickets!inner(channel_id)')
      .eq('status', 'approved')
      .eq('ticket.channel_id', channelId)
      .not('first_send_at', 'is', null)
      .lt('first_send_at', failCutoffIso);
    if (expSelErr) throw new Error(`reclaimStaleSending(expired-approved select) failed: ${expSelErr.message}`);
    const expiredApprovedIds = ((expApproved ?? []) as Array<{ id: string }>).map((r) => r.id);
    if (expiredApprovedIds.length > 0) {
      const { error: expErr } = await supa
        .from('ticket_drafts')
        .update({
          status: 'failed',
          last_error: 'line: approved but retry-key expired (first_send_at >24h, manual review)',
        })
        .in('id', expiredApprovedIds)
        .eq('status', 'approved')
        .lt('first_send_at', failCutoffIso);
      if (expErr) throw new Error(`reclaimStaleSending(expired-approved fail) failed: ${expErr.message}`);
    }

    return { released: releaseIds.length, failed: failIds.length + expiredApprovedIds.length };
  }

  async claimApprovedDrafts(channelId: string, limit: number): Promise<ClaimedLineDraft[]> {
    const supa = await getSupabaseAdmin();
    // 1. 候補抽出 (channel + 送信安全フィルタ + retry-key 未失効)
    // codex review P2: first_send_at>24h の approved は retry-key 失効済 → 再 push で二重配信。候補から除外
    // (reclaim が terminal 化するが、sweep 前 race の二重防御として claim 側でも弾く)。
    // 未送信 (first_send_at is null) は当然 claim 可。
    const retryKeyCutoffIso = new Date(Date.now() - RETRY_KEY_EXPIRY_MS).toISOString();
    const { data, error } = await supa
      .from('ticket_drafts')
      .select('id, body, ticket_id, ticket:tickets!inner(id, channel_id, channel_meta)')
      .eq('status', 'approved')
      .eq('ticket.channel_id', channelId)
      .or(SEND_SAFE_OR_FILTER)
      .or(`first_send_at.is.null,first_send_at.gte.${retryKeyCutoffIso}`)
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
    // first_send_at は claim 時には設定しない。claim したが (cron 死亡/300s 予算切れで) 実際に push
    // しなかった draft に retry-key 失効時計を進めてしまい、未送信のまま 24h で failed/除外されるのを防ぐ。
    // → 実 push の直前に markFirstSendAt() で stamp する (codex review P2)。
    const { data: claimed, error: claimErr } = await supa
      .from('ticket_drafts')
      .update({ status: 'sending', updated_at: new Date().toISOString() })
      .in('id', candidateIds)
      .eq('status', 'approved')
      .select('id, body, first_send_at');
    if (claimErr) throw new Error(`claimApprovedDrafts(claim) failed: ${claimErr.message}`);

    const claimedRows = (claimed ?? []) as Array<{
      id: string;
      body: string;
      first_send_at: string | null;
    }>;

    return claimedRows.map((r) => {
      const meta = byId.get(r.id);
      return {
        id: r.id,
        body: r.body,
        ticketId: meta?.ticketId ?? '',
        // source.type='user' の 1:1 のみ push 宛先に解決 (group/room は null → 送信側で failed)。
        toUserId: resolvePushUserId(meta?.channelMeta),
        firstSendAt: r.first_send_at,
      };
    });
  }

  async markFirstSendAt(draftId: string): Promise<void> {
    const supa = await getSupabaseAdmin();
    // set-once: 既に設定済 (再 claim) なら touch しない (retry-key 時計を進めない)。
    const { error } = await supa
      .from('ticket_drafts')
      .update({ first_send_at: new Date().toISOString() })
      .eq('id', draftId)
      .is('first_send_at', null);
    if (error) throw new Error(`markFirstSendAt failed: ${error.message}`);
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

      // 3b. 初回 push の直前に first_send_at を stamp (retry-key 使用開始 = この時刻が 24h 失効基準)。
      //     claim 時ではなくここで stamp することで、claim だけされ未 push の draft に時計を進めない。
      if (!draft.firstSendAt) {
        await repo.markFirstSendAt(draft.id);
      }
      // push (retryKey=draftId)
      const result = await pushWithBackoff(client, {
        to: draft.toUserId,
        text: draft.body,
        retryKey: draft.id,
      });
      const outcome = classifyLineSend(result.status, result.rawBody);

      // 3c. 分類して状態遷移
      if (outcome === 'sent') {
        // codex review P2: push は配信成功済。ここでの DB 失敗で approved に戻すと
        // (markSent/upsert が 24h 超え続けて失敗した場合) retry-key 失効後に再配信され二重送信になる。
        // → DB 失敗時は requeue せず 'sending' のまま残す。
        //   15m–24h は stale 再回収で approved→再送→409(既受理)で安全に収束、
        //   >24h は stale 再回収で failed (再送せず手動レビュー)。
        const sentAt = new Date().toISOString();
        const externalMessageId = buildExternalMessageId(result, draft.id);
        try {
          // codex review P2: 先に outbound message を記録 (onConflict で idempotent) してから
          // draft を 'sent' 確定する。逆順だと markSent 成功・upsert 失敗時に「配信済だが thread に
          // 無い」行が sent のまま残り再送もされない。この順なら upsert 失敗時は 'sending' のままで、
          // 15m–24h 再送→409→upsert(idempotent)→markSent でメッセージ欠落なく収束する。
          await repo.upsertOutboundMessage(
            draft.ticketId,
            formatChannelMessageId('line-reply', draft.id),
            draft.body,
            sentAt,
          );
          await repo.markSent(draft.id, externalMessageId, sentAt);
          succeeded += 1;
          logger.info('line.outbound.sent', {
            draftId: draft.id,
            status: result.status,
            externalMessageId,
          });
        } catch (dbErr) {
          // 配信済 / DB 記録失敗。status は 'sending' のまま (requeue しない)。
          failed += 1;
          const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
          errors.push({ draftId: draft.id, error: `sent-but-record-failed: ${msg}` });
          logger.error('line.outbound.sent_record_failed', { draftId: draft.id, error: msg });
        }
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
      failed += 1;
      const errMsg = err instanceof Error ? err.message : String(err);
      errors.push({ draftId: draft.id, error: errMsg });
      if (err instanceof LineTransportError) {
        // codex review P2: network/timeout は配信したか不明。approved に戻すと 'sending' 限定の
        // 24h retry-key ガードを失い、LINE が受理済だった場合に窓超え再送で二重配信し得る。
        // → 'sending' のまま残す。15m–24h は再送→409 で安全収束 / >24h は stale 再回収で failed。
        logger.error('line.outbound.transport_ambiguous_keep_sending', {
          draftId: draft.id,
          error: errMsg,
        });
      } else {
        // 非 transport (markFailed/releaseToApproved の DB エラー等)。push は配信していない
        // (sent path は内側 try で完結) ため approved に戻して次 cron で再試行。
        try {
          await repo.releaseToApproved(draft.id, `line push exception: ${errMsg}`);
        } catch (relErr) {
          // approved 戻しも失敗 → 'sending' のまま (reclaim が拾う)。
          logger.error('line.outbound.release_failed', {
            draftId: draft.id,
            error: relErr instanceof Error ? relErr.message : String(relErr),
          });
        }
        logger.error('line.outbound.exception', { draftId: draft.id, error: errMsg });
      }
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
