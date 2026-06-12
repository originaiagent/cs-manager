/**
 * Yahoo!ショッピング 問い合わせ (外部トーク) API のレスポンス型
 *
 * 仕様参照: https://developer.yahoo.co.jp/webapi/shopping/question/
 *   - 一覧: GET externalTalkList   (問い合わせトーク一覧。1 レスポンス上限 20 件)
 *   - 詳細: GET externalTalkDetail (1 トークの全メッセージ本文)
 *
 * ⚠️ 要検証: 実 API キー未取得のため実レスポンスで叩けていない。フィールド名は
 * 公式ドキュメント準拠の「想定形状」であり、本番接続前に実レスポンスとの突き合わせが必須。
 * 各フィールドの前提は JSDoc に明示する。defensive parse 方針:
 *   - 欠損フィールドは安全な既定値に丸める (throw しない)
 *   - 配列でない値は空配列に丸める
 */

/**
 * トーク一覧 1 件分のサマリ。
 *
 * 要検証フィールド前提:
 * - talkId:       トークの一意 ID (string | number 両対応で受ける)
 * - updateTime:   最終更新日時 (ISO 8601 風 / JST 想定)。増分絞り込みの基準
 * - status:       Yahoo 側の生ステータス文字列 (例 'open' / 'completed' / 'closed')
 * - customerName: 顧客表示名 (マスクされている可能性あり)
 * - subject:      件名 (無い場合あり)
 */
export interface YahooTalkListItem {
  talkId: string | number;
  updateTime?: string;
  status?: string;
  customerName?: string;
  subject?: string;
}

/**
 * externalTalkList のレスポンス全体。
 *
 * 要検証フィールド前提:
 * - result:    トーク配列 (1 ページ最大 20 件)
 * - totalPage: 総ページ数 (無い場合は件数 < 20 で終端判定する)
 * - totalCount / page: 補助。存在すれば利用、無ければ無視
 */
export interface YahooTalkListResponse {
  result?: YahooTalkListItem[];
  totalPage?: number;
  totalCount?: number;
  page?: number;
}

/**
 * トーク内の 1 メッセージ。
 *
 * 要検証フィールド前提:
 * - messageId:  メッセージ一意 ID (string | number)。無ければ index で補完
 * - body:       本文
 * - postTime:   投稿日時 (ISO 8601 風 / JST 想定)
 * - senderType: 送信者種別。顧客 → inbound, 店舗 → outbound に写像。
 *               想定値: 'customer' / 'buyer' / 'user' は顧客、
 *               'store' / 'seller' / 'merchant' / 'staff' は店舗。
 *               不明値は inbound 既定。
 * - senderName: 送信者表示名
 */
export interface YahooTalkMessage {
  messageId?: string | number;
  body?: string;
  postTime?: string;
  senderType?: string;
  senderName?: string;
}

/**
 * externalTalkDetail のレスポンス全体。
 *
 * 要検証フィールド前提:
 * - talkId:       対象トーク ID
 * - status:       生ステータス文字列
 * - customerName: 顧客表示名
 * - customerEmail: 顧客メール (マスク済みの可能性。存在すれば利用)
 * - subject:      件名
 * - itemId / itemName: 商品情報 (channelMeta に格納)
 * - orderId:      注文番号 (channelMeta に格納)
 * - completeTime: 完了日時 (resolvedAt に写像)
 * - messages:     メッセージ配列 (時系列)
 *
 * Yahoo は result でラップして返す想定。直下 / result 両方を defensive に許容する。
 */
export interface YahooTalkDetail {
  talkId?: string | number;
  status?: string;
  customerName?: string;
  customerEmail?: string;
  subject?: string;
  itemId?: string;
  itemName?: string;
  orderId?: string;
  completeTime?: string;
  updateTime?: string;
  messages?: YahooTalkMessage[];
}

/**
 * externalTalkDetail のトップレベル (result ラップ想定)。
 */
export interface YahooTalkDetailResponse {
  result?: YahooTalkDetail;
}
