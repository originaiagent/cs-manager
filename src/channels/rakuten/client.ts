import { buildRakutenAuthHeader, type RakutenCredentials } from './auth';
import type {
  RakutenGetInquiriesResponse,
  RakutenGetInquiryResponse,
  RakutenInquiryErrorResponse,
  RakutenReplyRequest,
  RakutenReplyResponse,
} from './types';

/**
 * 楽天 R-MessE (InquiryManagementAPI) HTTP クライアント
 *
 * - apiBase は channels.config.api_base から渡す（ハードコード禁止）
 * - 認証情報は constructor 引数で受ける (Core /api/credentials 経由で取得済み)
 * - 日付フォーマット: yyyy-MM-ddTHH:mm:ss（タイムゾーン無しの JST 想定）
 *   楽天 RMS は JST で扱われるため、Date を JST に変換して文字列化する
 */

const RAKUTEN_HTTP_TIMEOUT_MS = 30_000;

function formatRakutenDate(date: Date): string {
  // JST に変換（UTC+9）してから ISO 風文字列を組み立てる
  const jstMillis = date.getTime() + 9 * 60 * 60 * 1000;
  const d = new Date(jstMillis);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

export class RakutenApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = 'RakutenApiError';
  }
}

async function rakutenRequest<T>(
  url: string,
  authHeader: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: authHeader,
    Accept: 'application/json',
  };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method: init.method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(RAKUTEN_HTTP_TIMEOUT_MS),
  });

  const text = await res.text();
  if (!res.ok) {
    let parsed: RakutenInquiryErrorResponse | null = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* noop */ }
    const detail =
      parsed?.error?.message ?? text?.slice(0, 500) ?? '(empty response)';
    throw new RakutenApiError(
      `Rakuten API ${res.status} ${res.statusText}: ${detail}`,
      res.status,
      text,
    );
  }
  if (!text) {
    throw new RakutenApiError('Rakuten API returned empty body', res.status, '');
  }
  return JSON.parse(text) as T;
}

export interface RakutenClientConfig {
  apiBase: string;
  credentials: RakutenCredentials;
}

export class RakutenInquiryClient {
  private readonly authHeader: string;

  constructor(private readonly cfg: RakutenClientConfig) {
    if (!cfg.apiBase) throw new Error('RakutenInquiryClient: apiBase is required');
    if (!cfg.credentials) throw new Error('RakutenInquiryClient: credentials is required');
    this.authHeader = buildRakutenAuthHeader(cfg.credentials);
  }

  async listInquiries(params: {
    fromDate: Date;
    toDate: Date;
    limit: number;
    page: number;
  }): Promise<RakutenGetInquiriesResponse> {
    const q = new URLSearchParams({
      fromDate: formatRakutenDate(params.fromDate),
      toDate: formatRakutenDate(params.toDate),
      limit: String(params.limit),
      page: String(params.page),
    });
    const url = `${this.cfg.apiBase.replace(/\/$/, '')}/inquiries?${q.toString()}`;
    return rakutenRequest<RakutenGetInquiriesResponse>(url, this.authHeader, { method: 'GET' });
  }

  async getInquiry(inquiryNumber: string): Promise<RakutenGetInquiryResponse> {
    const url = `${this.cfg.apiBase.replace(/\/$/, '')}/inquiry/${encodeURIComponent(inquiryNumber)}`;
    return rakutenRequest<RakutenGetInquiryResponse>(url, this.authHeader, { method: 'GET' });
  }

  /**
   * 回答メッセージ送信。
   * - POST /inquiry/reply (body: { inquiryNumber, shopId, message, attachments? })
   * - レスポンスに message_id 相当が無いため、external_message_id は呼び出し側で
   *   直後に getInquiry() を叩いて replies[] から特定する設計。
   */
  async sendReply(req: RakutenReplyRequest): Promise<RakutenReplyResponse> {
    const url = `${this.cfg.apiBase.replace(/\/$/, '')}/inquiry/reply`;
    return rakutenRequest<RakutenReplyResponse>(url, this.authHeader, {
      method: 'POST',
      body: req,
    });
  }
}
