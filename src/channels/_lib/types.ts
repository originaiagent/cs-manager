/**
 * チャネル adapter 共通型
 *
 * 設計メモ:
 * - adapter は DB を一切知らない。ここで定義する正規化型を yield する。
 * - status は cs-manager 内部の 3 状態に丸める。チャネル固有の細かい状態は rawStatus に残す。
 * - channelMessageId は adapter 側で必ず非NULLで採番する。`_lib/ids.ts` の formatChannelMessageId() を使う。
 */

export type Direction = 'inbound' | 'outbound';

export type TicketStatus = 'untouched' | 'in_progress' | 'done';

export type SenderType = 'customer' | 'staff' | 'system';

export interface NormalizedAttachment {
  label?: string;
  path?: string;
  url?: string;
  meta?: Record<string, unknown>;
}

export interface NormalizedMessage {
  /** チャネル側ユニーク ID。formatChannelMessageId(prefix, id) で生成すること */
  channelMessageId: string;
  direction: Direction;
  body: string;
  senderName?: string;
  /** 任意: 'customer' | 'staff' | 'system'。direction と独立にチャネル側生情報を残す */
  senderType?: SenderType;
  /** ISO 8601 timestamp string */
  sentAt: string;
  attachments?: NormalizedAttachment[];
}

export interface NormalizedTicket {
  /** チャネル側のユニーク ID（楽天: inquiryNumber） */
  externalId: string;
  customerName?: string;
  customerEmail?: string;
  subject?: string;
  /** 内部 3 状態に丸めた値 */
  status: TicketStatus;
  /** 任意: チャネル側の生ステータス文字列。AI ドラフト等で参照したい場合に使う */
  rawStatus?: string;
  resolvedAt?: string;
  /** チャネル固有メタデータ（楽天の itemNumber, orderNumber, category, type 等） */
  channelMeta?: Record<string, unknown>;
}

export interface NormalizedTicketWithMessages {
  ticket: NormalizedTicket;
  messages: NormalizedMessage[];
}
