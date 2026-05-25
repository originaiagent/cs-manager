/**
 * Core (origin-core) を IdP とする OIDC 認証の **Edge 安全** ヘルパ。
 *
 * このモジュールは middleware (Edge runtime) から import されるため、
 * `jose` + Web 標準 API (atob / TextDecoder / URL) のみを使う。
 * node:crypto / Buffer / Core credential 取得など Node 専用処理は
 * core-oidc-node.ts に隔離する (Edge バンドルへの混入防止 — codex CONCERN #3)。
 *
 * 検証契約 (ec-manager server/lib/coreJwt.ts 準拠):
 *   - alg=ES256 / iss=`${base}/auth/v1` / aud='authenticated'
 *   - client_id claim === CORE_OAUTH_CLIENT_ID (他クライアント / 旧 Third-Party Auth
 *     由来トークンの誤受理を防ぐ — codex CONCERN #1)
 *   - 認可は app_metadata.tool_access['cs-manager'] === true (fail-closed)
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

/** GoTrue access_token の固定 audience (OAuth client_id ではない)。 */
const TOKEN_AUDIENCE = 'authenticated';

/** Core Supabase の base URL (末尾スラッシュ除去)。未設定は fail-closed。 */
function coreBase(): string {
  const url = process.env.NEXT_PUBLIC_CORE_SUPABASE_URL;
  if (!url) throw new Error('NEXT_PUBLIC_CORE_SUPABASE_URL not set (fail-closed)');
  return url.replace(/\/+$/, '');
}

export function coreIssuer(): string {
  return `${coreBase()}/auth/v1`;
}

export function coreJwksUrl(): string {
  return `${coreBase()}/auth/v1/.well-known/jwks.json`;
}

/** Core プロジェクト ref (session cookie 名に使う)。 */
export function coreSupabaseRef(): string {
  return new URL(coreBase()).hostname.split('.')[0];
}

/** origin-core セッション cookie 名 (Supabase ref ベース)。 */
export function sessionCookieName(): string {
  return `sb-${coreSupabaseRef()}-auth-token`;
}

// module-scope singleton (毎回生成すると JWKS キャッシュが効かない — codex CONCERN #3)。
let _jwks: JWTVerifyGetKey | null = null;
function getJwks(): JWTVerifyGetKey {
  if (!_jwks) _jwks = createRemoteJWKSet(new URL(coreJwksUrl()));
  return _jwks;
}

export interface VerifiedUser {
  userId: string;
  email: string | null;
  toolAccess: Record<string, unknown>;
  clientId: string | null;
}

/**
 * Core 発行 access_token を JWKS 検証する。alg/sig/iss/aud/client_id を確認 (fail-closed)。
 * 失敗時は throw。
 *
 * client_id の期待値:
 *   - `expectedClientId` 引数があればそれを優先 (callback は Core から実行時取得した
 *     authoritative な client_id を渡す = 単一の正)。
 *   - 無ければ `CORE_OAUTH_CLIENT_ID` env (Edge=middleware は Core 取得できないため、
 *     非 secret な client_id をビルド時 config として pin する。ローテーション時は env 更新が必要)。
 *   - どちらも無ければ fail-closed。
 */
export async function verifyCoreAccessToken(
  token: string,
  expectedClientId?: string,
): Promise<VerifiedUser> {
  if (!token) throw new Error('verifyCoreAccessToken: empty token');

  const expected = expectedClientId ?? process.env.CORE_OAUTH_CLIENT_ID;
  if (!expected) {
    throw new Error('verifyCoreAccessToken: no expected client_id (env CORE_OAUTH_CLIENT_ID unset) (fail-closed)');
  }

  const { payload } = await jwtVerify(token, getJwks(), {
    issuer: coreIssuer(),
    audience: TOKEN_AUDIENCE,
    algorithms: ['ES256'],
  });

  const clientId = typeof payload.client_id === 'string' ? payload.client_id : null;
  if (clientId !== expected) {
    throw new Error('verifyCoreAccessToken: client_id claim mismatch');
  }

  const appMeta =
    payload.app_metadata && typeof payload.app_metadata === 'object' && !Array.isArray(payload.app_metadata)
      ? (payload.app_metadata as Record<string, unknown>)
      : {};
  const toolAccess =
    appMeta.tool_access && typeof appMeta.tool_access === 'object' && !Array.isArray(appMeta.tool_access)
      ? (appMeta.tool_access as Record<string, unknown>)
      : {};

  return {
    userId: String(payload.sub || ''),
    email: payload.email ? String(payload.email) : null,
    toolAccess,
    clientId,
  };
}

/** Web 標準のみで base64(UTF-8 JSON) をデコード (Buffer 非依存 = Edge 安全)。 */
function b64ToString(b64: string): string {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * session cookie 値から access_token を取り出す。
 * 値は callback が格納する `base64-<json({access_token,expires_at})>` 形式。
 * 後方互換: 生 JWT (dot 3 つ) もそのまま返す。
 */
export function extractAccessToken(cookieValue: string | undefined | null): string | null {
  if (!cookieValue) return null;
  let value = cookieValue;
  if (value.startsWith('base64-')) {
    try {
      value = b64ToString(value.slice('base64-'.length));
    } catch {
      return null;
    }
  }
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object') {
      return typeof parsed.access_token === 'string' ? parsed.access_token : null;
    }
  } catch {
    if (value.split('.').length === 3) return value;
  }
  return null;
}
