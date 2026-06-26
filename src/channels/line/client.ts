/**
 * LINE Messaging API HTTP クライアント (push 送信)
 *
 * - エンドポイント: POST https://api.line.me/v2/bot/message/push
 * - 認証: `Authorization: Bearer <channel_access_token>` (auth.ts)
 * - 冪等性: `X-Line-Retry-Key` (draft の UUID をそのまま使用)。同一 retry key の再送を
 *   LINE が 24h 重複防止する。既に受理済なら 409 を返す (= 配送済 = 送信成功扱い)。
 * - HTTP ステータスは throw せず LinePushResult として返し、成功/transient/permanent の
 *   分類は classifyLineSend() (純関数) に集約する。network/timeout は LineTransportError を throw。
 *
 * 公式:
 *  - push: https://developers.line.biz/en/reference/messaging-api/#send-push-message
 *  - retry: https://developers.line.biz/en/docs/messaging-api/retrying-api-request/
 */

import { buildLineAuthHeader, type LineCredentials } from './auth';
import {
  LineTransportError,
  type LinePushResponseBody,
  type LinePushResult,
} from './types';

const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';
const LINE_HTTP_TIMEOUT_MS = 30_000;

export type LineSendOutcome = 'sent' | 'transient' | 'permanent';

/**
 * HTTP ステータス + 本文から送信結果を分類する (純関数)。
 *
 * - 2xx: 送信成功。
 * - 409: 同一 X-Line-Retry-Key が既に受理済 (= 配送済) → 送信成功扱い。
 * - 401: channel_access_token の失効/ローテーション (Core credential 5分キャッシュが旧トークンを
 *        保持している場合を含む) = チャネル単位の修復可能な認証問題 → transient (token 修正後に再送)。
 *        codex review P2: permanent にすると顧客返信が手動修復まで恒久 drop されるため retryable にする。
 * - 429: rate limit は transient (再送可)。月間送信上限超過は当月再送不可なので permanent
 *        (cron 連打を防ぐ。本文の "monthly limit" で判別)。
 * - 5xx: transient。
 * - その他 4xx (400/403/404 等): permanent (per-draft の不正/宛先不可で再送しても成功しない)。
 */
export function classifyLineSend(status: number, rawBody: string): LineSendOutcome {
  if (status >= 200 && status < 300) return 'sent';
  if (status === 409) return 'sent';
  if (status === 401) return 'transient';
  if (status === 429) return isMonthlyLimitExceeded(rawBody) ? 'permanent' : 'transient';
  if (status >= 500) return 'transient';
  return 'permanent';
}

/** LINE の月間送信上限超過 (429 のうち再送不可なもの) を本文で判別する。 */
export function isMonthlyLimitExceeded(rawBody: string): boolean {
  // 例: {"message":"You have reached your monthly limit."}
  return /monthly\s+limit/i.test(rawBody);
}

export interface LineClientConfig {
  credentials: LineCredentials;
  /** テスト時に fetch を差し替える。 */
  fetchImpl?: typeof fetch;
}

export class LineMessagingClient {
  private readonly authHeader: string;
  private readonly fetchFn: typeof fetch;

  constructor(cfg: LineClientConfig) {
    if (!cfg.credentials) throw new Error('LineMessagingClient: credentials is required');
    this.authHeader = buildLineAuthHeader(cfg.credentials);
    this.fetchFn = cfg.fetchImpl ?? fetch;
  }

  /**
   * push メッセージを 1 通送る。HTTP 応答が得られた場合は status を問わず LinePushResult を返す
   * (分類は呼び出し側 classifyLineSend)。network/timeout は LineTransportError を throw。
   */
  async pushMessage(args: { to: string; text: string; retryKey: string }): Promise<LinePushResult> {
    let res: Response;
    try {
      res = await this.fetchFn(LINE_PUSH_URL, {
        method: 'POST',
        headers: {
          Authorization: this.authHeader,
          'Content-Type': 'application/json',
          'X-Line-Retry-Key': args.retryKey,
        },
        body: JSON.stringify({
          to: args.to,
          messages: [{ type: 'text', text: args.text }],
        }),
        signal: AbortSignal.timeout(LINE_HTTP_TIMEOUT_MS),
      });
    } catch (err: any) {
      const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw new LineTransportError(
        isTimeout ? `Timeout after ${LINE_HTTP_TIMEOUT_MS}ms` : `Network error: ${err?.message ?? String(err)}`,
      );
    }

    const rawBody = await res.text().catch(() => '');
    let sentMessageId: string | null = null;
    if (res.status >= 200 && res.status < 300 && rawBody) {
      try {
        const parsed = JSON.parse(rawBody) as LinePushResponseBody;
        sentMessageId = parsed.sentMessages?.[0]?.id ?? null;
      } catch {
        // sentMessages が無い/壊れていても送信自体は成功。id は後段で fallback。
      }
    }

    return {
      status: res.status,
      sentMessageId,
      acceptedRequestId: res.headers.get('x-line-accepted-request-id'),
      requestId: res.headers.get('x-line-request-id'),
      rawBody,
    };
  }
}
