/**
 * Yahoo!ショッピング 問い合わせ (質問) API HTTP クライアント
 *
 * 公式仕様で突合:
 *  - 一覧 externalTalkList: params sellerId(必須), start(1始まり), result(最大20),
 *    dateType/startDate/endDate(日付絞り込み, 任意), sort 等。
 *  - 詳細 externalTalkDetail: params sellerId(必須), topicId(必須)。
 *
 * - apiBase は channels.config.api_base から渡す (ハードコード禁止)
 * - 認証は Bearer <access_token> (ctx.credentials 由来)。constructor 引数で受ける。
 * - 429 / 非 200 は明確に throw。
 * - 1 req/s のレート制御 (throttle) は adapter 側の責務。client は throttle しない。
 * - fetch は注入可能 (テストでフェイク応答を差し込む)。
 */
import type {
  YahooTalkDetailResponse,
  YahooTalkListResponse,
} from './types';

const YAHOO_HTTP_TIMEOUT_MS = 30_000;

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export class YahooApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = 'YahooApiError';
  }
}

export interface YahooClientConfig {
  apiBase: string;
  accessToken: string;
  /** テスト注入用。未指定なら global fetch */
  fetchImpl?: FetchLike;
}

export interface ListTalksParams {
  /** ストアアカウント識別子 (= Core scope_key と同一)。必須。 */
  sellerId: string;
  /** 取得開始位置 (1 始まり)。 */
  start: number;
  /** 取得件数 (最大 20)。 */
  result: number;
  /** 日付絞り込み種別 (⚠️要検証 enum)。指定時のみ startDate/endDate を送る。 */
  dateType?: string;
  /** 絞り込み開始日 (dateType 指定時)。 */
  startDate?: string;
  /** 絞り込み終了日 (dateType 指定時)。 */
  endDate?: string;
}

export class YahooTalkClient {
  private readonly apiBase: string;
  private readonly accessToken: string;
  private readonly fetchImpl: FetchLike;

  constructor(cfg: YahooClientConfig) {
    if (!cfg.apiBase) throw new Error('YahooTalkClient: apiBase is required');
    if (!cfg.accessToken) throw new Error('YahooTalkClient: accessToken is required');
    this.apiBase = cfg.apiBase.replace(/\/$/, '');
    this.accessToken = cfg.accessToken;
    this.fetchImpl = cfg.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private async request<T>(path: string, query: URLSearchParams): Promise<T> {
    const url = `${this.apiBase}/${path}?${query.toString()}`;
    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(YAHOO_HTTP_TIMEOUT_MS),
    });

    const text = await res.text();
    if (res.status === 429) {
      throw new YahooApiError(`Yahoo API 429 rate limited: ${text.slice(0, 300)}`, 429, text);
    }
    if (!res.ok) {
      throw new YahooApiError(
        `Yahoo API ${res.status} ${res.statusText}: ${text.slice(0, 500) || '(empty response)'}`,
        res.status,
        text,
      );
    }
    if (!text) return {} as T; // 空ボディは defensive に空オブジェクト
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new YahooApiError(`Yahoo API returned non-JSON body: ${text.slice(0, 200)}`, res.status, text);
    }
  }

  /** 質問一覧。start/result でページング (page ではない)。 */
  async listTalks(params: ListTalksParams): Promise<YahooTalkListResponse> {
    const q = new URLSearchParams({
      sellerId: params.sellerId,
      start: String(params.start),
      result: String(params.result),
    });
    if (params.dateType && params.startDate && params.endDate) {
      q.set('dateType', params.dateType);
      q.set('startDate', params.startDate);
      q.set('endDate', params.endDate);
    }
    return this.request<YahooTalkListResponse>('externalTalkList', q);
  }

  /** 質問詳細 (全メッセージ)。sellerId + topicId 必須。 */
  async getTalkDetail(params: { sellerId: string; topicId: string | number }): Promise<YahooTalkDetailResponse> {
    const q = new URLSearchParams({
      sellerId: params.sellerId,
      topicId: String(params.topicId),
    });
    return this.request<YahooTalkDetailResponse>('externalTalkDetail', q);
  }
}
