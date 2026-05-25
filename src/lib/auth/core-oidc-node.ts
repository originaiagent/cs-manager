/**
 * Core OIDC の **Node 専用** ヘルパ (login / callback route から使用、runtime='nodejs')。
 *
 * node:crypto (PKCE/state) と Core credential 実行時取得を含むため、Edge から import しない
 * (Edge 安全な検証は core-oidc-edge.ts — codex CONCERN #3)。
 *
 * 重要 (codex APPROVE 時の実装注意):
 *   redirect_uri は getRedirectUri() の単一固定生成関数のみを使う。
 *   Host / X-Forwarded-* / request URL からは絶対に導出しない。
 *   login の authorize / callback の token 交換で同一値を使うこと。
 */
import { randomBytes, createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// redirect_uri (単一固定生成 — request 由来禁止)
// ---------------------------------------------------------------------------

/** APP_BASE_URL (本番 https 固定) を返す。未設定 / 非 https は fail-closed。 */
export function appBaseUrl(): string {
  const raw = process.env.APP_BASE_URL;
  if (!raw) throw new Error('APP_BASE_URL not set (fail-closed)');
  const base = raw.replace(/\/+$/, '');
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    throw new Error('APP_BASE_URL is not a valid URL');
  }
  if (u.protocol !== 'https:' && u.hostname !== 'localhost') {
    throw new Error('APP_BASE_URL must be https');
  }
  return base;
}

/** OAuth redirect_uri (Core 登録値・metadata と 3-way 一致させる固定値)。 */
export function getRedirectUri(): string {
  return `${appBaseUrl()}/api/auth/callback`;
}

export function appIsSecure(): boolean {
  return appBaseUrl().startsWith('https://');
}

// ---------------------------------------------------------------------------
// PKCE / state
// ---------------------------------------------------------------------------

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function generateState(redirectPath: string): string {
  const nonce = base64url(randomBytes(16));
  return base64url(Buffer.from(JSON.stringify({ n: nonce, r: redirectPath })));
}

export function parseState(state: string): { nonce: string; redirect: string } | null {
  try {
    const json = Buffer.from(state.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const obj = JSON.parse(json);
    return { nonce: String(obj.n ?? ''), redirect: typeof obj.r === 'string' ? obj.r : '/' };
  } catch {
    return null;
  }
}

export function newCsrfToken(): string {
  return base64url(randomBytes(24));
}

// ---------------------------------------------------------------------------
// Core credential 実行時取得 (client_secret は env に置かない)
// ---------------------------------------------------------------------------

const CORE_API_URL_DEFAULT = 'https://origin-core-465031496778.asia-northeast1.run.app';

const CORE_HOST_ALLOWLIST = new Set([
  'origin-core-465031496778.asia-northeast1.run.app',
  'origin-core-dev-465031496778.asia-northeast1.run.app',
  'origin-core.origin-tree.com',
]);

function getCoreApiUrl(): string {
  return (process.env.CORE_API_URL || CORE_API_URL_DEFAULT).trim();
}

function getInternalApiKey(): string | undefined {
  return process.env.INTERNAL_API_KEY?.replace(/\s+$/, '');
}

/** CORE_API_URL を https + 既知 host + default port のみに厳格化 (鍵漏洩防止)。 */
function validateCoreOrigin(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:') return false;
    if (u.port !== '' && u.port !== '443') return false;
    return CORE_HOST_ALLOWLIST.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export class CredentialFetchError extends Error {
  status: number | null;
  serviceCode: string;
  constructor(message: string, status: number | null, serviceCode: string) {
    super(message);
    this.name = 'CredentialFetchError';
    this.status = status;
    this.serviceCode = serviceCode;
  }
}

interface CredentialResponse {
  credentials?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/** 当ツール自身の OAuth client を指す scope_key。 */
export const ORIGINAI_OAUTH_SCOPE_KEY = 'cs-manager';

const CACHE_TTL_MS = 5 * 60 * 1000;
let _cache: { at: number; value: CredentialResponse } | null = null;

async function fetchOriginAIOAuthCredential(): Promise<CredentialResponse> {
  if (_cache && Date.now() - _cache.at < CACHE_TTL_MS) return _cache.value;

  const coreUrl = getCoreApiUrl();
  const apiKey = getInternalApiKey();
  if (!apiKey) throw new CredentialFetchError('INTERNAL_API_KEY is not set', null, 'originai_oauth');
  if (!validateCoreOrigin(coreUrl)) {
    throw new CredentialFetchError('CORE_API_URL is not an allowed https origin', null, 'originai_oauth');
  }

  const url = new URL(`${coreUrl.replace(/\/$/, '')}/api/credentials/originai_oauth`);
  url.searchParams.set('scope_key', ORIGINAI_OAUTH_SCOPE_KEY);

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'X-Internal-API-Key': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
  } catch (err) {
    throw new CredentialFetchError(`Network error: ${(err as Error)?.message ?? err}`, null, 'originai_oauth');
  }
  if (!res.ok) {
    try {
      await res.arrayBuffer();
    } catch {
      /* ignore */
    }
    throw new CredentialFetchError(`Core ${res.status}`, res.status, 'originai_oauth');
  }
  const body = (await res.json()) as CredentialResponse;
  _cache = { at: Date.now(), value: body };
  return body;
}

export interface OriginAIOAuth {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  /** Core credential metadata に登録された redirect_uri (3-way 検証用)。 */
  metadataRedirectUri: string | null;
}

/**
 * OriginAI OAuth client 設定を Core から実行時取得する。
 * issuer_url / client_id / client_secret のいずれか欠落で fail-closed。値は一切 log しない。
 */
export async function getOriginAIOAuth(): Promise<OriginAIOAuth> {
  const body = await fetchOriginAIOAuthCredential();
  const creds = body?.credentials ?? {};
  const issuerUrl = creds.issuer_url;
  const clientId = creds.client_id;
  const clientSecret = creds.client_secret;
  const metadataRedirectUri =
    body?.metadata && typeof body.metadata.redirect_uri === 'string'
      ? (body.metadata.redirect_uri as string)
      : null;

  if (typeof issuerUrl !== 'string' || !issuerUrl) {
    throw new CredentialFetchError('credential has no issuer_url', null, 'originai_oauth');
  }
  if (typeof clientId !== 'string' || !clientId) {
    throw new CredentialFetchError('credential has no client_id', null, 'originai_oauth');
  }
  if (typeof clientSecret !== 'string' || !clientSecret) {
    throw new CredentialFetchError('credential has no client_secret', null, 'originai_oauth');
  }
  return { issuerUrl, clientId, clientSecret, metadataRedirectUri };
}

/** 設定された Core Supabase の base origin (NEXT_PUBLIC_CORE_SUPABASE_URL 由来)。 */
function expectedCoreBase(): string | null {
  const raw = process.env.NEXT_PUBLIC_CORE_SUPABASE_URL;
  if (!raw) return null;
  return raw.replace(/\/+$/, '').replace(/\/auth\/v1$/, '');
}

/**
 * issuer_url から Core OAuth エンドポイントを導出する。
 * issuer_url は base 形式 / /auth/v1 付きの両方を許容。https 絶対 URL でなければ throw。
 *
 * codex FAIL #3 反映: credential 由来の issuer_url を無制限に信頼しない。
 *   設定済み Core origin (NEXT_PUBLIC_CORE_SUPABASE_URL) と同一 origin であることを必須にし、
 *   誤登録 credential で authorize 誘導 / client_secret の token POST 先が任意 origin に
 *   なるのを防ぐ。
 */
export function deriveOAuthEndpoints(issuerUrl: string): {
  base: string;
  authorizeUrl: string;
  tokenUrl: string;
} {
  const base = String(issuerUrl)
    .replace(/\/+$/, '')
    .replace(/\/auth\/v1$/, '');
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new CredentialFetchError('issuer_url is not a valid absolute URL', null, 'originai_oauth');
  }
  if (parsed.protocol !== 'https:') {
    throw new CredentialFetchError('issuer_url must be https', null, 'originai_oauth');
  }
  const expected = expectedCoreBase();
  if (expected) {
    let expectedOrigin: string;
    try {
      expectedOrigin = new URL(expected).origin;
    } catch {
      throw new CredentialFetchError('configured Core base is invalid', null, 'originai_oauth');
    }
    if (parsed.origin !== expectedOrigin) {
      throw new CredentialFetchError('issuer_url origin does not match configured Core', null, 'originai_oauth');
    }
  }
  return {
    base,
    authorizeUrl: `${base}/auth/v1/oauth/authorize`,
    tokenUrl: `${base}/auth/v1/oauth/token`,
  };
}

/**
 * 検証済み相対パスを APP_BASE_URL 上の絶対 URL に解決する (オープンリダイレクト多層防御)。
 * sanitizeRedirectPath 済みパスを渡す前提だが、解決後 origin が APP_BASE_URL と
 * 一致しなければ強制的に `/` に落とす (codex FAIL #1 の最終防御)。
 */
export function resolveSameOriginRedirect(path: string): URL {
  const baseOrigin = new URL(appBaseUrl()).origin;
  let url: URL;
  try {
    url = new URL(path || '/', appBaseUrl());
  } catch {
    return new URL('/', appBaseUrl());
  }
  if (url.origin !== baseOrigin) {
    return new URL('/', appBaseUrl());
  }
  return url;
}
