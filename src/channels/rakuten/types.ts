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
