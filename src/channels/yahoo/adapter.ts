/**
 * Yahoo!ショッピング 問い合わせ受信 (pull) アダプタ
 *
 * - 認証 token は ctx.credentials から読む (orchestrator が Core /api/credentials/yahoo_shopping
 *   を解決して注入)。service_code はハードコードせず、getCredential も自前で呼ばない。
 * - since→now で externalTalkList をページ走査 (1 ページ 20 件上限 → 必ずページネーション)。
 *   各 talk を externalTalkDetail で取得し NormalizedTicketWithMessages に map して yield。
 * - レート制限 1 req/s → 各 API 呼び出し間に最低 1000ms の sleep を必ず入れる。
 * - 送信系は一切実装しない。
 */
import type {
  ChannelAdapter,
  ChannelAdapterContext,
} from '../_lib/adapter';
import { formatChannelMessageId } from '../_lib/ids';
import type {
  Direction,
  NormalizedMessage,
  NormalizedTicket,
  NormalizedTicketWithMessages,
} from '../_lib/types';
import { YahooTalkClient, type FetchLike } from './client';
import type {
  YahooTalkDetail,
  YahooTalkListItem,
  YahooTalkMessage,
} from './types';

const DEFAULT_API_BASE = 'https://circus.shopping.yahooapis.jp/ShoppingWebService/V1';
/** Yahoo レート制限 1 req/s。各 API 呼び出し間の最小ディレイ。 */
const RATE_LIMIT_DELAY_MS = 1000;
/** externalTalkList の 1 レスポンス上限。これ未満なら最終ページと判定。 */
const PAGE_SIZE = 20;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function asStr(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

function cfgRecord(ctx: ChannelAdapterContext): Record<string, unknown> {
  return (ctx.channel.config ?? {}) as Record<string, unknown>;
}

/**
 * ctx.credentials から OAuth access token を取り出す。
 * access_token を第一候補、token をフォールバックに許容。無ければ throw。
 */
function resolveAccessToken(ctx: ChannelAdapterContext): string {
  const creds = ctx.credentials ?? {};
  const primary = (creds as Record<string, unknown>).access_token;
  const fallback = (creds as Record<string, unknown>).token;
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
 * Yahoo 日付文字列を ISO 8601 に変換。タイムゾーン情報が無ければ JST と解釈。
 * 解釈不能な値は now() に丸める (throw しない / defensive)。
 */
function toIsoString(raw: string | null | undefined): string {
  if (!raw) return new Date().toISOString();
  const hasTz = /[zZ]|[+-]\d\d:?\d\d$/.test(raw);
  const normalized = hasTz ? raw : `${raw}+09:00`;
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

const CUSTOMER_SENDER_TYPES = new Set(['customer', 'buyer', 'user', 'consumer']);
const STORE_SENDER_TYPES = new Set(['store', 'seller', 'merchant', 'staff', 'shop']);

/**
 * Yahoo senderType を direction に写像。顧客→inbound, 店舗→outbound。
 * 不明値は inbound 既定。
 */
function toDirection(senderType: string | undefined): Direction {
  const s = (senderType ?? '').toLowerCase();
  if (STORE_SENDER_TYPES.has(s)) return 'outbound';
  if (CUSTOMER_SENDER_TYPES.has(s)) return 'inbound';
  return 'inbound';
}

/** 完了系の生ステータスを 'done' に、それ以外を 'untouched' に丸める。 */
function toTicketStatus(rawStatus: string | undefined): 'untouched' | 'done' {
  const s = (rawStatus ?? '').toLowerCase();
  if (s === 'completed' || s === 'complete' || s === 'closed' || s === 'done' || s === 'resolved') {
    return 'done';
  }
  return 'untouched';
}

function toNormalizedTicket(
  talkId: string,
  detail: YahooTalkDetail,
  listItem: YahooTalkListItem | undefined,
): NormalizedTicket {
  const rawStatus = asStr(detail.status, asStr(listItem?.status, ''));
  const channelMeta: Record<string, unknown> = {};
  if (detail.itemId) channelMeta.itemId = detail.itemId;
  if (detail.itemName) channelMeta.itemName = detail.itemName;
  if (detail.orderId) channelMeta.orderId = detail.orderId;
  const updateTime = asStr(detail.updateTime, asStr(listItem?.updateTime, ''));
  if (updateTime) channelMeta.updateTime = updateTime;

  return {
    externalId: talkId,
    customerName: asStr(detail.customerName, asStr(listItem?.customerName, '')) || undefined,
    customerEmail: asStr(detail.customerEmail, '') || undefined,
    subject: asStr(detail.subject, asStr(listItem?.subject, '')) || undefined,
    status: toTicketStatus(rawStatus || undefined),
    rawStatus: rawStatus || undefined,
    resolvedAt: detail.completeTime ? toIsoString(detail.completeTime) : undefined,
    channelMeta: Object.keys(channelMeta).length > 0 ? channelMeta : undefined,
  };
}

function toNormalizedMessage(
  talkId: string,
  msg: YahooTalkMessage,
  index: number,
): NormalizedMessage {
  const direction = toDirection(msg.senderType);
  // messageId 欠損時は talkId + index で安定した擬似 ID を採番 (冪等性のため決定的に)。
  const rawId =
    msg.messageId !== undefined && msg.messageId !== null && msg.messageId !== ''
      ? msg.messageId
      : `${talkId}-${index}`;
  return {
    channelMessageId: formatChannelMessageId('talk', rawId),
    direction,
    body: asStr(msg.body, ''),
    senderName: asStr(msg.senderName, '') || undefined,
    senderType: direction === 'outbound' ? 'staff' : 'customer',
    sentAt: toIsoString(msg.postTime),
  };
}

function unwrapDetail(resp: { result?: YahooTalkDetail } | YahooTalkDetail | undefined): YahooTalkDetail {
  if (!resp) return {};
  // result ラップ / 直下 両対応 (defensive)。
  if ('result' in resp && resp.result && typeof resp.result === 'object') {
    return resp.result as YahooTalkDetail;
  }
  return resp as YahooTalkDetail;
}

export const yahooAdapter: ChannelAdapter = {
  code: 'yahoo',

  async *fetchInbox(
    ctx: ChannelAdapterContext,
  ): AsyncGenerator<NormalizedTicketWithMessages, void, void> {
    const cfg = cfgRecord(ctx);
    const apiBase = asStr(cfg.api_base, DEFAULT_API_BASE);
    const accessToken = resolveAccessToken(ctx);
    // テスト注入用 fetch (config.__fetchImpl 経由)。本番では undefined → global fetch。
    const fetchImpl = (cfg.__fetchImpl as FetchLike | undefined) ?? undefined;

    const client = new YahooTalkClient({ apiBase, accessToken, fetchImpl });

    const since = ctx.since ?? null;
    ctx.logger.info('yahoo.fetchInbox.start', {
      since: since ? since.toISOString() : null,
      apiBase,
    });

    let page = 1;
    let yielded = 0;
    let firstApiCall = true;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // 各 API 呼び出し間に 1req/s throttle (先頭呼び出しは待たない)。
      if (!firstApiCall) await sleep(RATE_LIMIT_DELAY_MS);
      firstApiCall = false;

      const list = await client.listTalks({ page, since });
      const items = Array.isArray(list.result) ? list.result : [];
      const totalPage = typeof list.totalPage === 'number' ? list.totalPage : undefined;

      ctx.logger.info('yahoo.fetchInbox.page', {
        page,
        count: items.length,
        totalPage: totalPage ?? null,
      });

      for (const item of items) {
        const talkId =
          item.talkId !== undefined && item.talkId !== null && item.talkId !== ''
            ? String(item.talkId)
            : '';
        if (!talkId) {
          ctx.logger.warn('yahoo.fetchInbox.skip_missing_talkId', { page });
          continue;
        }

        // detail 取得前に throttle。
        await sleep(RATE_LIMIT_DELAY_MS);
        let detail: YahooTalkDetail;
        try {
          const resp = await client.getTalkDetail(talkId);
          detail = unwrapDetail(resp);
        } catch (err) {
          ctx.logger.warn('yahoo.fetchInbox.getTalkDetail_failed', {
            talkId,
            error: err instanceof Error ? err.message : String(err),
          });
          // 詳細取得失敗時は一覧情報のみで最小構成 (メッセージ無し)。
          detail = {};
        }

        const ticket = toNormalizedTicket(talkId, detail, item);
        const rawMessages = Array.isArray(detail.messages) ? detail.messages : [];
        const messages: NormalizedMessage[] = rawMessages.map((m, i) =>
          toNormalizedMessage(talkId, m, i),
        );

        yielded += 1;
        yield { ticket, messages };
      }

      // 終端判定: totalPage 到達 or 1 ページ件数が上限未満。
      const reachedTotalPage = totalPage !== undefined && page >= totalPage;
      const partialPage = items.length < PAGE_SIZE;
      if (reachedTotalPage || partialPage) break;

      page += 1;
    }

    ctx.logger.info('yahoo.fetchInbox.done', { yielded, pages: page });
  },
};
