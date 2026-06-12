/**
 * LINE webhook event → 正規化型 (純関数、DB 非依存)
 *
 * 取り込み対象は text message event のみ (type='message' かつ message.type='text')。
 * それ以外 (sticker / image / follow / postback 等) は呼び出し側で無視する。
 *
 * 設計レビュー: codex CONCERN (2026-06-12)。
 *  - ticket.externalId: タスク確定仕様に従い `source.userId ?? message.id` (1ユーザー1スレッド優先)。
 *    codex 指摘 (done ticket 再オープン / inbox 並び順) は返信未実装 MVP の範囲外。
 *    会話単位束ね時に status 再オープン・並び順・スレッド境界をまとめて設計する (TODO)。
 *  - PII (本文/userId) は呼び出し側でログ/エラーに出さない。本関数は I/O を持たない。
 *
 * 公式: https://developers.line.biz/en/reference/messaging-api/#message-event
 */

import type { NormalizedTicket, NormalizedMessage } from '@/channels/_lib/types';
import { formatChannelMessageId } from '@/channels/_lib/ids';
import type { RagReplyInput } from '@/lib/rag/reply-adapter';

/** LINE webhook の単一 event (取り込みに必要な部分のみ型付け)。 */
export interface LineWebhookEvent {
  type: string;
  message?: {
    id: string;
    type: string;
    text?: string;
  };
  source: {
    type: string;
    userId?: string;
  };
  replyToken?: string;
  timestamp: number;
  webhookEventId?: string;
  deliveryContext?: { isRedelivery: boolean };
}

export interface LineWebhookBody {
  destination: string;
  events: LineWebhookEvent[];
}

export interface NormalizedLineMessage {
  ticket: NormalizedTicket;
  inboundMessage: NormalizedMessage;
  ragInput: RagReplyInput;
}

/**
 * text message event か判定する。
 * 取り込み対象 (type='message' かつ message.type='text' かつ text 非空) のみ true。
 */
export function isTextMessageEvent(ev: LineWebhookEvent): boolean {
  return (
    ev.type === 'message' &&
    ev.message?.type === 'text' &&
    typeof ev.message.text === 'string' &&
    ev.message.text.length > 0 &&
    typeof ev.message.id === 'string' &&
    ev.message.id.length > 0
  );
}

/**
 * text message event を正規化する。
 *
 * @param ev text message event (isTextMessageEvent が true のもの)
 * @param channelId 解決済み line channel の UUID (RAG 絞り込み用)
 * @throws event が text message でない場合
 */
export function normalizeLineTextEvent(
  ev: LineWebhookEvent,
  channelId: string,
): NormalizedLineMessage {
  if (!isTextMessageEvent(ev) || !ev.message) {
    throw new Error('normalizeLineTextEvent: not a text message event');
  }
  const message = ev.message;
  const text = message.text as string;
  const userId = ev.source.userId;

  // 1ユーザー1スレッド優先 (userId)。userId 不在 (group/room 等) は message.id にフォールバック。
  // TODO(codex CONCERN): 会話束ねを正式採用する際は done ticket 再オープン・inbox 並び順・
  //   スレッド境界をまとめて設計する。現状は返信未実装 MVP のため共通 ingest の冪等契約に委ねる。
  const externalId = userId ?? message.id;

  const ticket: NormalizedTicket = {
    externalId,
    // LINE は表示名を別 API 取得 (今回しない) ため customerName は持たない。
    status: 'untouched',
    channelMeta: {
      source: 'line',
      // userId は PII。channel_meta (service_role 限定 RLS) にのみ保持し、ログ/エラーには出さない。
      userId: userId ?? null,
      webhookEventId: ev.webhookEventId ?? null,
    },
  };

  const inboundMessage: NormalizedMessage = {
    channelMessageId: formatChannelMessageId('line', message.id),
    direction: 'inbound',
    body: text,
    senderType: 'customer',
    sentAt: new Date(ev.timestamp).toISOString(),
  };

  const ragInput: RagReplyInput = {
    subject: null,
    inquiryBody: text,
    customerName: null,
    channelId,
    tenantId: null,
  };

  return { ticket, inboundMessage, ragInput };
}
