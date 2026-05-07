import { buildRakutenAuthHeader, getRakutenCredentials } from './auth';
import type {
  RakutenGetInquiriesResponse,
  RakutenGetInquiryResponse,
  RakutenInquiryErrorResponse,
} from './types';

/**
 * 楽天 R-MessE (InquiryManagementAPI) HTTP クライアント
 *
 * - apiBase は channels.config.api_base から渡す（ハードコード禁止）
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

async function rakutenGet<T>(url: string): Promise<T> {
  const creds = getRakutenCredentials();
  const auth = buildRakutenAuthHeader(creds);

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: auth,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(RAKUTEN_HTTP_TIMEOUT_MS),
  });

  const text = await res.text();
  if (!res.ok) {
    let parsed: RakutenInquiryErrorResponse | null = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* noop */ }
    const detail =
      parsed?.error?.message ?? text?.slice(0, 500) ?? '(empty response)';
    throw new Error(`Rakuten API ${res.status} ${res.statusText}: ${detail}`);
  }
  if (!text) {
    throw new Error('Rakuten API returned empty body');
  }
  return JSON.parse(text) as T;
}

export interface RakutenClientConfig {
  apiBase: string;
}

export class RakutenInquiryClient {
  constructor(private readonly cfg: RakutenClientConfig) {
    if (!cfg.apiBase) throw new Error('RakutenInquiryClient: apiBase is required');
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
    return rakutenGet<RakutenGetInquiriesResponse>(url);
  }

  async getInquiry(inquiryNumber: string): Promise<RakutenGetInquiryResponse> {
    const url = `${this.cfg.apiBase.replace(/\/$/, '')}/inquiry/${encodeURIComponent(inquiryNumber)}`;
    return rakutenGet<RakutenGetInquiryResponse>(url);
  }
}
