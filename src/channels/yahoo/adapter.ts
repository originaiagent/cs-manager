/**
 * Yahoo!ショッピング 問い合わせ (質問) 受信 (pull) アダプタ
 *
 * 公式仕様で突合 (developer.yahoo.co.jp/webapi/shopping/question/):
 *  - 一覧 externalTalkList: start/result でページング (最大 20)、summary.topic.count で全件数。
 *  - 詳細 externalTalkDetail: sellerId + topicId、messages[] に全メッセージ。
 *
 * - 認証 token は ctx.credentials から読む (orchestrator が Core /api/credentials/yahoo_shopping
 *   を解決して注入)。service_code ハードコードなし・getCredential 自前呼出なし。
 * - sellerId は ctx.channel.config.store_id (= Core scope_key と同一)。
 * - レート制限 1 req/s → 各 API 呼び出し間に最低 1000ms の sleep。
 * - 増分: since 以降の更新分のみ (userPostTime/sellerPostTime を client 側で比較)。
 *   dateType enum が未検証のため、日付絞り込みは config.date_type 指定時のみ送り、既定は
 *   client 側フィルタに倒す (誤 enum による 400 回避)。
 * - 送信系は一切実装しない。
 */
import type { ChannelAdapter, ChannelAdapterContext } from '../_lib/adapter';
import { formatChannelMessageId } from '../_lib/ids';
import type {
  Direction,
  NormalizedAttachment,
  NormalizedMessage,
  NormalizedTicket,
  NormalizedTicketWithMessages,
} from '../_lib/types';
import { YahooTalkClient, YahooApiError, type FetchLike } from './client';
import type {
  YahooTalkDetailResponse,
  YahooTalkListHeadline,
  YahooTalkMessage,
} from './types';

const DEFAULT_API_BASE = 'https://circus.shopping.yahooapis.jp/ShoppingWebService/V1';
const RATE_LIMIT_DELAY_MS = 1000;
/** 1 リクエストの取得件数上限 (公式: result 最大 20)。 */
const PAGE_RESULT = 20;
/** 無限ループ防御の最大ページ数。 */
const MAX_PAGES = 200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function asStr(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

function cfgRecord(ctx: ChannelAdapterContext): Record<string, unknown> {
  return (ctx.channel.config ?? {}) as Record<string, unknown>;
}

function resolveAccessToken(ctx: ChannelAdapterContext): string {
  const creds = (ctx.credentials ?? {}) as Record<string, unknown>;
  const primary = creds.access_token;
  const fallback = creds.token;
  const token =
    (typeof primary === 'string' && primary.length > 0 && primary) ||
    (typeof fallback === 'string' && fallback.length > 0 && fallback) ||
    '';
  if (!token) {
    throw new Error(
      `yahoo.fetchInbox: access token not found in ctx.credentials (expected access_token or token) (channel_id=${ctx.channel.id})`,
    );
  }
  return token;
}

/**
 * sellerId (= Yahoo ストアアカウント) を解決する。
 * 「Core にキーを入れるだけ」を満たすため Core credential を第一とし、config はフォールバック:
 *   1. ctx.credentials.seller_id / store_id (Core が token と一緒に返す。これだけで稼働可)
 *   2. channels.config.store_id / seller_id (複数店舗等で明示したい場合)
 */
function resolveSellerId(ctx: ChannelAdapterContext, cfg: Record<string, unknown>): string {
  const creds = (ctx.credentials ?? {}) as Record<string, unknown>;
  const fromCred = asStr(creds.seller_id, asStr(creds.store_id, ''));
  const fromCfg = asStr(cfg.store_id, asStr(cfg.seller_id, ''));
  const sellerId = fromCred || fromCfg;
  if (!sellerId) {
    throw new Error(
      `yahoo.fetchInbox: sellerId not found (expected Core credential seller_id or channels.config.store_id) (channel_id=${ctx.channel.id})`,
    );
  }
  return sellerId;
}

/**
 * UNIX秒/ミリ秒/日付文字列を ISO 8601 に変換 (defensive)。
 * - 数値 or 数値文字列: 1e12 未満は秒とみなし ×1000、以上はミリ秒。
 * - それ以外: 日付文字列として解釈 (TZ 無しは JST)。解釈不能は now()。
 */
function postTimeToIso(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return new Date().toISOString();
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isFinite(n) && (typeof v === 'number' || /^\d+$/.test(String(v)))) {
    const ms = n < 1e12 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }
  const raw = String(v);
  const hasTz = /[zZ]|[+-]\d\d:?\d\d$/.test(raw);
  const d = new Date(hasTz ? raw : `${raw}+09:00`);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/** epoch(ms) を返す (since 比較用)。解釈不能は null。 */
function toEpochMs(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const iso = postTimeToIso(v);
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

const SELLER_SENDER_TOKENS = ['seller', 'store', 'merchant', 'staff', 'shop'];

/**
 * postUserType を direction に写像。店舗側→outbound、それ以外→inbound 既定。
 * ⚠️要検証: postUserType の具体値 (実キー取得後に突合)。文字列の seller 系のみ outbound 判定。
 */
function toDirection(postUserType: string | number | undefined): Direction {
  if (postUserType === undefined || postUserType === null) return 'inbound';
  const s = String(postUserType).toLowerCase();
  if (SELLER_SENDER_TOKENS.some((t) => s.includes(t))) return 'outbound';
  return 'inbound';
}

function toAttachments(msg: YahooTalkMessage): NormalizedAttachment[] | undefined {
  const files = Array.isArray(msg.fileList) ? msg.fileList : [];
  if (files.length === 0) return undefined;
  return files.map((f) => ({
    label: f.fileName,
    path: f.objectKey,
    url: f.thumbnailUrl,
    meta: { fileExt: f.fileExt, fileSize: f.fileSize },
  }));
}

function buildTicket(
  topicId: string,
  headline: YahooTalkListHeadline,
  detail: YahooTalkDetailResponse,
): NormalizedTicket {
  const topic = detail.topic ?? {};
  const completed = topic.isComplete === true || headline.isCompleted === true;
  const channelMeta: Record<string, unknown> = {};
  const itemCode = asStr(topic.itemcode, asStr(headline.itemCode, ''));
  const orderId = asStr(topic.orderid, asStr(headline.orderId, ''));
  if (itemCode) channelMeta.itemCode = itemCode;
  if (orderId) channelMeta.orderId = orderId;
  if (topic.categoryName) channelMeta.categoryName = topic.categoryName;
  // 顧客識別子はマスク済 ID のみ (氏名は API が返さない)。
  const userMasked = asStr(headline.userMaskedId, asStr(topic.userMaskedIdx, ''));
  if (userMasked) channelMeta.userMaskedId = userMasked;

  return {
    externalId: topicId,
    customerName: undefined,
    subject: asStr(topic.title, asStr(headline.title, '')) || undefined,
    status: completed ? 'done' : 'untouched',
    rawStatus: completed ? 'completed' : 'open',
    channelMeta: Object.keys(channelMeta).length > 0 ? channelMeta : undefined,
  };
}

function buildMessage(topicId: string, msg: YahooTalkMessage, index: number): NormalizedMessage {
  const direction = toDirection(msg.postUserType);
  const rawId =
    msg.messageId !== undefined && msg.messageId !== null && msg.messageId !== ''
      ? msg.messageId
      : `${topicId}-${index}`;
  return {
    channelMessageId: formatChannelMessageId('talk', rawId),
    direction,
    body: asStr(msg.body, ''),
    senderType: direction === 'outbound' ? 'staff' : 'customer',
    sentAt: postTimeToIso(msg.postdate),
    attachments: toAttachments(msg),
  };
}

/** headline の最新投稿時刻 (顧客/店舗の新しい方) を epoch(ms) で返す。 */
function headlineLatestMs(h: YahooTalkListHeadline): number | null {
  const u = toEpochMs(h.userPostTime);
  const s = toEpochMs(h.sellerPostTime);
  if (u === null) return s;
  if (s === null) return u;
  return Math.max(u, s);
}

export const yahooAdapter: ChannelAdapter = {
  code: 'yahoo',

  async *fetchInbox(
    ctx: ChannelAdapterContext,
  ): AsyncGenerator<NormalizedTicketWithMessages, void, void> {
    const cfg = cfgRecord(ctx);
    const apiBase = asStr(cfg.api_base, DEFAULT_API_BASE);
    const accessToken = resolveAccessToken(ctx);
    // sellerId は Core credential 優先 (キー投入だけで稼働)、config はフォールバック。
    const sellerId = resolveSellerId(ctx, cfg);
    const dateType = asStr(cfg.date_type, '') || undefined;
    const fetchImpl = (cfg.__fetchImpl as FetchLike | undefined) ?? undefined;

    const client = new YahooTalkClient({ apiBase, accessToken, fetchImpl });
    const since = ctx.since ?? null;
    const sinceMs = since ? since.getTime() : null;

    ctx.logger.info('yahoo.fetchInbox.start', {
      since: since ? since.toISOString() : null,
      sellerId: sellerId ? 'set' : 'missing',
    });

    let start = 1;
    let yielded = 0;
    let firstApiCall = true;
    let pageGuard = 0;

    while (pageGuard < MAX_PAGES) {
      pageGuard += 1;
      if (!firstApiCall) await sleep(RATE_LIMIT_DELAY_MS);
      firstApiCall = false;

      const listParams: Parameters<typeof client.listTalks>[0] = { sellerId, start, result: PAGE_RESULT };
      if (dateType && since) {
        // 公式: dateType 指定時の startDate/endDate は UNIX 時刻 (秒)。ISO ではない。
        listParams.dateType = dateType;
        listParams.startDate = String(Math.floor(since.getTime() / 1000));
        listParams.endDate = String(Math.floor(Date.now() / 1000));
      }
      const list = await client.listTalks(listParams);
      const headlines = Array.isArray(list.headlines) ? list.headlines : [];
      const count = list.summary?.topic?.count;

      ctx.logger.info('yahoo.fetchInbox.page', {
        start,
        got: headlines.length,
        count: typeof count === 'number' ? count : null,
      });

      for (const h of headlines) {
        const topicId =
          h.topicId !== undefined && h.topicId !== null && h.topicId !== '' ? String(h.topicId) : '';
        if (!topicId) {
          ctx.logger.warn('yahoo.fetchInbox.skip_missing_topicId', { start });
          continue;
        }
        // since 以降のみ (client 側フィルタ。ordering 不定のため hard-stop はしない)。
        if (sinceMs !== null) {
          const latest = headlineLatestMs(h);
          if (latest !== null && latest < sinceMs) continue;
        }

        await sleep(RATE_LIMIT_DELAY_MS);
        let detail: YahooTalkDetailResponse;
        let detailFailed = false;
        try {
          detail = await client.getTalkDetail({ sellerId, topicId });
        } catch (err) {
          // PII 非露出: status/name のみログ (err.message に Yahoo body は載らない設計だが二重防御)。
          ctx.logger.warn('yahoo.fetchInbox.getTalkDetail_failed_degraded', {
            topicId,
            status: err instanceof YahooApiError ? err.status : null,
            name: err instanceof Error ? err.name : 'unknown',
          });
          detail = {};
          detailFailed = true;
        }

        const ticket = buildTicket(topicId, h, detail);
        const rawMessages = Array.isArray(detail.messages) ? detail.messages : [];
        let messages: NormalizedMessage[] = rawMessages.map((m, i) => buildMessage(topicId, m, i));
        // detail 取得失敗時は一覧 headline の body を inbound メッセージにフォールバック。
        // 設計判断 (codex コードレビュー指摘への対応): 受信MVPの主目的=顧客の問い合わせ文→
        // ドラフト生成。headline.body は問い合わせ本文を含むため、detail 失敗でも primary 価値
        // (顧客メッセージ捕捉+ドラフト) は失われない。失われるのは full スレッド履歴/添付 (secondary)。
        // ⚠️ go-live ゲート: orchestrator の wall-clock cursor と組み合わせると detail 復旧後も
        //   full スレッドを再取得しない (cursor が当該 topic を通過するため)。完全な再取得保証は、
        //   yahoo 実 API 挙動の確認後に「topic 単位の取込状態管理 or server dateType 絞り込み」で
        //   ハードニングする (yahoo 有効化前の必須対応)。本 MVP は degraded 捕捉+loud ログに留める。
        if (detailFailed && messages.length === 0) {
          const fallbackBody = asStr(h.body, '');
          if (fallbackBody) {
            messages = [
              {
                channelMessageId: formatChannelMessageId('talk', `${topicId}:headline`),
                direction: 'inbound',
                body: fallbackBody,
                senderType: 'customer',
                sentAt: postTimeToIso(h.userPostTime ?? h.sellerPostTime),
              },
            ];
          }
        }

        yielded += 1;
        yield { ticket, messages };
      }

      // 終端判定: count に達した or 取得件数が result 未満。
      const reachedCount = typeof count === 'number' && start + PAGE_RESULT > count;
      const partialPage = headlines.length < PAGE_RESULT;
      if (reachedCount || partialPage) break;
      start += PAGE_RESULT;
    }

    ctx.logger.info('yahoo.fetchInbox.done', { yielded });
  },
};
