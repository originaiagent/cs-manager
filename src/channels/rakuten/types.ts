/**
 * 楽天 R-MessE (InquiryManagementAPI) のレスポンス型
 *
 * 仕様参照: JakeJP/Rakuten.RMS.Api の Models.cs（公式 .NET 互換ライブラリ）
 * https://api.rms.rakuten.co.jp/es/1.0/inquirymng-api/...
 */

export interface RakutenInquiryAttachment {
  label?: string;
  path?: string;
}

export interface RakutenInquiryReply {
  id: number;
  message: string;
  /** ISO 8601-like, タイムゾーンなし or +09:00 想定 */
  regDate: string;
  isRead?: boolean;
  isMessageDeleted?: boolean;
  attachments?: RakutenInquiryAttachment[];
}

export interface RakutenInquiry {
  inquiryNumber: string;
  shopId?: number;
  userName?: string;
  /** ユーザーマスクメールアドレス */
  userMaskEmail?: string;
  message: string;
  regDate: string;
  itemUrl?: string;
  itemName?: string;
  itemNumber?: string;
  isCompleted?: boolean;
  completedDate?: string | null;
  orderNumber?: string;
  readByMerchant?: boolean;
  attachments?: RakutenInquiryAttachment[];
  replies?: RakutenInquiryReply[];
  category?: string;
  type?: string;
  isMessageDeleted?: boolean;
  lastUpdateDate?: string;
}

export interface RakutenGetInquiriesResponse {
  totalCount: number;
  totalPageCount: number;
  page: number;
  list?: RakutenInquiry[];
}

export interface RakutenGetInquiryResponse {
  result: RakutenInquiry;
}

export interface RakutenInquiryErrorResponse {
  error?: {
    code?: string;
    message?: string;
    targets?: Record<string, string>;
  };
}

/**
 * 送信 (回答返信) リクエスト/レスポンス
 *
 * 仕様参照: JakeJP/Rakuten.RMS.Api InquiryManagementAPI Reply()
 * POST {apiBase}/inquiry/reply
 */
export interface RakutenReplyRequest {
  inquiryNumber: string;
  shopId: string;
  message: string;
  attachments?: RakutenInquiryAttachment[];
}

export interface RakutenReplyResponse {
  result: {
    inquiryNumber: string;
    message: string;
    /** ISO 8601-like, タイムゾーンなし or +09:00 想定。external_message_id 特定用 */
    regDate: string;
    replyFrom?: string;
    isRead?: boolean;
    attachments?: RakutenInquiryAttachment[];
  };
}

/**
 * R-MessE 受信メッセージ (cs-manager 内部の正規化前の生メッセージ表現)
 * RakutenInquiry をベースに inbound 用途で再エクスポート。
 */
export type RakutenRMesseMessage = RakutenInquiry;

/**
 * 送信ドラフト (cs-manager 内部の ticket_drafts 行を adapter 入力形式に変換したもの)
 */
export interface RakutenRMesseDraft {
  /** ticket_drafts.id */
  draftId: string;
  /** ticket_drafts.ticket_id 経由で解決された tickets.external_id (= 楽天 inquiryNumber) */
  inquiryNumber: string;
  /** channels.config.shop_id (Core /api/credentials の scope_key と同一) */
  shopId: string;
  /** ticket_drafts.body */
  body: string;
  /** 任意。R-MessE への添付 (label/path) */
  attachments?: RakutenInquiryAttachment[];
}
