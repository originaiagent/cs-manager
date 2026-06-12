/**
 * Yahoo!ショッピング 問い合わせ (外部トーク) API HTTP クライアント
 *
 * - apiBase は channels.config.api_base から渡す (ハードコード禁止)
 * - 認証は Bearer <access_token> (ctx.credentials 由来)。constructor 引数で受ける。
 * - 429 / 非 200 は明確に throw する。
 * - 1 req/s のレート制御 (throttle) は adapter 側の責務。client は throttle しない。
 *
 * fetch は注入可能 (テストでフェイク応答を差し込むため)。
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
      throw new YahooApiError(
        `Yahoo API 429 rate limited: ${text.slice(0, 300)}`,
        429,
        text,
      );
    }
    if (!res.ok) {
      throw new YahooApiError(
        `Yahoo API ${res.status} ${res.statusText}: ${text.slice(0, 500) || '(empty response)'}`,
        res.status,
        text,
      );
    }
    if (!text) {
      // 空ボディは defensive に空オブジェクトとして返す (parse 側で既定値処理)
      return {} as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new YahooApiError(
        `Yahoo API returned non-JSON body: ${text.slice(0, 200)}`,
        res.status,
        text,
      );
    }
  }

  /**
   * 問い合わせトーク一覧。1 ページ最大 20 件。
   * @param params.page 1 始まり
   * @param params.since 増分起点 (更新日時下限)。null なら絞り込まない
   */
  async listTalks(params: { page: number; since: Date | null }): Promise<YahooTalkListResponse> {
    const q = new URLSearchParams({ page: String(params.page) });
    if (params.since) {
      // ⚠️ 要検証: 更新日時の絞り込みパラメータ名。公式想定 'updateTimeFrom' を採用。
      q.set('updateTimeFrom', params.since.toISOString());
    }
    return this.request<YahooTalkListResponse>('externalTalkList', q);
  }

  /**
   * 1 トークの詳細 (全メッセージ)。
   */
  async getTalkDetail(talkId: string | number): Promise<YahooTalkDetailResponse> {
    const q = new URLSearchParams({ talkId: String(talkId) });
    return this.request<YahooTalkDetailResponse>('externalTalkDetail', q);
  }
}
