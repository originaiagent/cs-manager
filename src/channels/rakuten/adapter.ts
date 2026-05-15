import type {
  ChannelAdapter,
  ChannelAdapterContext,
} from '../_lib/adapter';
import { formatChannelMessageId } from '../_lib/ids';
import type {
  NormalizedMessage,
  NormalizedTicket,
  NormalizedTicketWithMessages,
} from '../_lib/types';
import { getCredential } from '@/lib/credentials';
import type { RakutenCredentials } from './auth';
import { RakutenInquiryClient } from './client';
import type { RakutenInquiry, RakutenInquiryReply } from './types';

const DEFAULT_PAGE_LIMIT = 100;
const DEFAULT_REQUEST_DELAY_MS = 200;
const DEFAULT_LOOKBACK_MINUTES = 15;

function asInt(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback;
}

function asStr(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

/**
 * 楽天 regDate (例: "2026-05-07T12:34:56" or with offset) を ISO 8601 文字列に変換。
 * オフセット情報がない場合 JST と解釈する。
 */
function toIsoString(rakutenDate: string | null | undefined): string {
  if (!rakutenDate) return new Date().toISOString();
  // 末尾に Z や ±hh:mm が無い場合は JST と解釈
  const hasTz = /[zZ]|[+-]\d\d:?\d\d$/.test(rakutenDate);
  const normalized = hasTz ? rakutenDate : `${rakutenDate}+09:00`;
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) {
    // Fallback: 解釈不能な値は now() で代替し、警告にとどめる（throw しない）
    return new Date().toISOString();
  }
  return d.toISOString();
}

function toNormalizedTicket(inq: RakutenInquiry): NormalizedTicket {
  const status = inq.isCompleted ? 'done' : 'untouched';
  const channelMeta: Record<string, unknown> = {};
  if (inq.shopId !== undefined) channelMeta.shopId = inq.shopId;
  if (inq.itemNumber) channelMeta.itemNumber = inq.itemNumber;
  if (inq.itemName) channelMeta.itemName = inq.itemName;
  if (inq.itemUrl) channelMeta.itemUrl = inq.itemUrl;
  if (inq.orderNumber) channelMeta.orderNumber = inq.orderNumber;
  if (inq.category) channelMeta.category = inq.category;
  if (inq.type) channelMeta.type = inq.type;
  if (inq.lastUpdateDate) channelMeta.lastUpdateDate = inq.lastUpdateDate;

  return {
    externalId: inq.inquiryNumber,
    customerName: inq.userName,
    customerEmail: inq.userMaskEmail,
    subject: inq.itemName ? `[${inq.itemName}] ${inq.message?.slice(0, 60) ?? ''}` : undefined,
    status,
    rawStatus: inq.isCompleted ? 'completed' : 'open',
    resolvedAt: inq.completedDate ? toIsoString(inq.completedDate) : undefined,
    channelMeta,
  };
}

function toInboundMessage(inq: RakutenInquiry): NormalizedMessage {
  return {
    channelMessageId: formatChannelMessageId('inquiry', inq.inquiryNumber),
    direction: 'inbound',
    body: inq.message ?? '',
    senderName: inq.userName,
    senderType: 'customer',
    sentAt: toIsoString(inq.regDate),
    attachments: (inq.attachments ?? []).map((a) => ({
      label: a.label,
      path: a.path,
    })),
  };
}

function toOutboundMessage(reply: RakutenInquiryReply): NormalizedMessage {
  return {
    channelMessageId: formatChannelMessageId('reply', reply.id),
    direction: 'outbound',
    body: reply.message ?? '',
    senderType: 'staff',
    sentAt: toIsoString(reply.regDate),
    attachments: (reply.attachments ?? []).map((a) => ({
      label: a.label,
      path: a.path,
    })),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const rakutenAdapter: ChannelAdapter = {
  code: 'rakuten',

  async *fetchInbox(
    ctx: ChannelAdapterContext,
  ): AsyncGenerator<NormalizedTicketWithMessages, void, void> {
    const cfg = ctx.channel.config ?? {};
    const apiBase = asStr(
      (cfg as Record<string, unknown>).api_base,
      'https://api.rms.rakuten.co.jp/es/1.0/inquirymng-api',
    );
    const limit = asInt((cfg as Record<string, unknown>).page_limit, DEFAULT_PAGE_LIMIT);
    const delayMs = asInt(
      (cfg as Record<string, unknown>).request_delay_ms,
      DEFAULT_REQUEST_DELAY_MS,
    );
    const lookbackMin = asInt(
      (cfg as Record<string, unknown>).lookback_minutes,
      DEFAULT_LOOKBACK_MINUTES,
    );
    // 楽天店舗 ID は channels.config.shop_id に格納する運用。
    // Core /api/credentials の scope_key にも同じ値を渡す (1 店舗 1 credential 世代)。
    const shopId = asStr((cfg as Record<string, unknown>).shop_id, '');
    if (!shopId) {
      throw new Error(
        `rakuten.fetchInbox: channels.config.shop_id is required (channel_id=${ctx.channel.id})`,
      );
    }

    // Core から credential 動的取得 (5 分 TTL キャッシュ)
    const credResp = await getCredential<RakutenCredentials>('rakuten_rmesse', shopId);
    const client = new RakutenInquiryClient({ apiBase, credentials: credResp.credentials });

    const now = new Date();
    const fromDate =
      ctx.since ?? new Date(now.getTime() - lookbackMin * 60 * 1000);
    const toDate = now;

    ctx.logger.info('rakuten.fetchInbox.start', {
      fromDate: fromDate.toISOString(),
      toDate: toDate.toISOString(),
      limit,
    });

    let page = 1;
    let totalPageCount = 1;
    let yielded = 0;

    while (page <= totalPageCount) {
      const list = await client.listInquiries({ fromDate, toDate, limit, page });
      totalPageCount = list.totalPageCount ?? 1;

      const inquiries = list.list ?? [];
      ctx.logger.info('rakuten.fetchInbox.page', {
        page,
        totalPageCount,
        count: inquiries.length,
      });

      for (const summary of inquiries) {
        // 詳細取得（replies 込み）
        await sleep(delayMs);
        let detail: RakutenInquiry;
        try {
          const got = await client.getInquiry(summary.inquiryNumber);
          detail = got.result ?? summary;
        } catch (err) {
          ctx.logger.warn('rakuten.fetchInbox.getInquiry_failed', {
            inquiryNumber: summary.inquiryNumber,
            error: err instanceof Error ? err.message : String(err),
          });
          // 詳細取得失敗時は summary のみで構成（replies は無し）
          detail = summary;
        }

        const ticket = toNormalizedTicket(detail);
        const messages: NormalizedMessage[] = [toInboundMessage(detail)];
        for (const reply of detail.replies ?? []) {
          messages.push(toOutboundMessage(reply));
        }

        yielded += 1;
        yield { ticket, messages };
      }

      page += 1;
      if (page <= totalPageCount) await sleep(delayMs);
    }

    ctx.logger.info('rakuten.fetchInbox.done', { yielded });
  },
};
