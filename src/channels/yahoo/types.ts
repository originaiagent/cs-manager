/**
 * Yahoo!ショッピング 問い合わせ (質問) API レスポンス型
 *
 * 公式仕様で突合 (2026-06-12, codex コードレビュー指摘を受け実ドキュメントに整合):
 *  - 質問一覧API: https://developer.yahoo.co.jp/webapi/shopping/question/list.html
 *  - 質問詳細API: https://developer.yahoo.co.jp/webapi/shopping/question/detail.html
 *
 * パース方針: defensive。欠損は安全な既定値に丸め、throw しない。
 * 一部の値域 (postUserType の具体値 / postdate の単位 / dateType enum) は実レスポンスとの
 * 最終突合がゲート項目 (実キー取得後)。⚠️要検証 を付す。
 */

/** 質問一覧API: summary.topic ページング情報。 */
export interface YahooTalkListSummaryTopic {
  /** 取得開始位置 (1 始まり) */
  start?: number;
  /** 取得終了位置 */
  end?: number;
  /** 全件数 */
  count?: number;
}

export interface YahooTalkListSummary {
  filter?: unknown;
  unansweredCount?: number;
  topic?: YahooTalkListSummaryTopic;
}

/** 質問一覧API: headlines[] の 1 件 (topic=1問い合わせスレッド)。 */
export interface YahooTalkListHeadline {
  topicId: string | number;
  isUnread?: boolean;
  isNoAnswer?: boolean;
  isCompleted?: boolean;
  completeConditionId?: string | number;
  completeConditionShortName?: string;
  /** 顧客側 最終投稿時刻 (⚠️要検証: UNIX秒 or 日付文字列) */
  userPostTime?: string | number;
  /** 店舗側 最終投稿時刻 */
  sellerPostTime?: string | number;
  qaType?: string;
  isPrivate?: boolean;
  category?: string;
  title?: string;
  body?: string;
  messageCount?: number;
  /** 顧客マスク済み ID (PII 低減済の識別子) */
  userMaskedId?: string;
  itemCode?: string;
  orderId?: string;
  firstPoster?: string;
  serviceType?: string;
}

export interface YahooTalkListResponse {
  summary?: YahooTalkListSummary;
  headlines?: YahooTalkListHeadline[];
}

/** 質問詳細API: messages[].fileList の添付。 */
export interface YahooTalkDetailFile {
  fileName?: string;
  objectKey?: string;
  fileExt?: string;
  thumbnailUrl?: string;
  fileSize?: number;
}

/** 質問詳細API: messages[] の 1 メッセージ。 */
export interface YahooTalkMessage {
  messageId?: string | number;
  /** 投稿者種別 (⚠️要検証: 顧客/店舗を表す値。文字列 or 数値) */
  postUserType?: string | number;
  bid?: string | number;
  /** 投稿時刻 (⚠️要検証: UNIX秒想定。文字列日付も defensive 許容) */
  postdate?: string | number;
  body?: string;
  fileList?: YahooTalkDetailFile[];
}

/** 質問詳細API: topic オブジェクト (スレッドメタ)。 */
export interface YahooTalkDetailTopic {
  accessUserType?: string | number;
  userLastReadTime?: string | number;
  isUserUnRead?: boolean;
  sellerLastReadTime?: string | number;
  isSellerUnRead?: boolean;
  isPrivate?: boolean;
  isComplete?: boolean;
  completeConditionId?: string | number;
  isMail?: boolean;
  userMaskedIdx?: string;
  itemcode?: string;
  orderid?: string;
  categoryid?: string | number;
  categoryName?: string;
  title?: string;
}

export interface YahooTalkDetailResponse {
  topic?: YahooTalkDetailTopic;
  messages?: YahooTalkMessage[];
}
