/**
 * LINE Messaging API 送信 (push) の型 + エラー型
 *
 * 公式: https://developers.line.biz/en/reference/messaging-api/#send-push-message
 */

/** push 本文 (text のみ。MVP は text メッセージ 1 通)。 */
export interface LineTextMessage {
  type: 'text';
  text: string;
}

export interface LinePushRequest {
  to: string;
  messages: LineTextMessage[];
}

/** push 成功時に返り得る送信済みメッセージ識別子。 */
export interface LineSentMessage {
  id?: string;
  quoteToken?: string;
}

export interface LinePushResponseBody {
  sentMessages?: LineSentMessage[];
}

/**
 * pushMessage の結果 (HTTP ステータスは throw せず返し、分類は呼び出し側で行う)。
 * network/timeout 等の transport エラーのみ LineTransportError を throw する。
 */
export interface LinePushResult {
  /** HTTP ステータス (200/409/429/4xx/5xx)。 */
  status: number;
  /** sentMessages[0].id (200 時のみ存在し得る)。 */
  sentMessageId: string | null;
  /** `x-line-accepted-request-id` (409=既受理時の配送識別子)。 */
  acceptedRequestId: string | null;
  /** `x-line-request-id` (このリクエスト自体の ID。配送識別子としては弱い)。 */
  requestId: string | null;
  /** レスポンス本文 (PII を含まない LINE のエラーメッセージ。分類に使用)。 */
  rawBody: string;
}

/** network/timeout 等、HTTP 応答に至らなかった transport 障害。outbound では transient 扱い。 */
export class LineTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LineTransportError';
  }
}
