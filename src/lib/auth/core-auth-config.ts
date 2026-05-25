/**
 * Core (origin-core) を IdP とする OIDC 認証の純粋な定数・ヘルパ。
 *
 * このファイルはサーバ/ブラウザ/Edge いずれからも import され得る純粋関数のみを持つ
 * (env 直参照は最小限、jose / node:crypto / Core 取得は core-oidc-{edge,node}.ts 側)。
 */

/**
 * ユーザー認証ゲートの ON/OFF フラグ。
 *
 * - 既定 OFF: middleware は素通し = 現行 (ユーザーログイン無し) の挙動を完全維持。
 * - ON: ユーザー向けページに Core ログイン + tool_access (`TOOL_KEY`) を要求。
 *
 * NEXT_PUBLIC_ なのでビルド時にインライン化される。フラグ変更には再デプロイが必要。
 */
export function isCoreAuthEnabled(): boolean {
  return process.env.NEXT_PUBLIC_CORE_AUTH_ENABLED === 'true';
}

/**
 * Core 認証に必要なビルド時 env がそろっているか。
 *
 * OIDC リダイレクト方式では、middleware が `NEXT_PUBLIC_CORE_SUPABASE_URL` から
 * issuer / JWKS URL を導出して access_token を検証する。これがログインボタン表示の
 * 最低条件。OAuth client_secret / client_id / APP_BASE_URL 等のサーバ専用設定は
 * /api/auth/* 経路が実行時に fail-closed で検証する (ここでは見ない)。
 */
export function isCoreAuthConfigured(): boolean {
  return !!process.env.NEXT_PUBLIC_CORE_SUPABASE_URL;
}

/**
 * cs-manager へのアクセス可否を判定する Core JWT のツールアクセスキー。
 *
 * PINNED JWT CONTRACT (core-tool-access と一致):
 *   - `app_metadata.tool_access` は 8 個のハイフン付きツールキーを持つ object。
 *   - middleware / callback のゲートで `tool_access['cs-manager'] === true` を要求する。
 */
export const TOOL_KEY = 'cs-manager';

/**
 * app_metadata.tool_access から cs-manager のアクセス権を持つか判定する (fail-closed)。
 * 厳密に `tool_access['cs-manager'] === true` のときのみ許可。
 */
export function hasToolAccess(
  appMetadata: Record<string, unknown> | null | undefined,
): boolean {
  const toolAccess = appMetadata?.tool_access;
  if (!toolAccess || typeof toolAccess !== 'object' || Array.isArray(toolAccess)) {
    return false;
  }
  return (toolAccess as Record<string, unknown>)[TOOL_KEY] === true;
}

/**
 * オープンリダイレクト防止: 自オリジン相対パスのみ許可する。
 *
 * 弾く対象 (いずれも既定 `/` にフォールバック):
 *   - 文字列でない / 空
 *   - `/` で始まらない (絶対 URL / scheme)
 *   - `//` (プロトコル相対 → 別オリジン)
 *   - バックスラッシュを含む (`/\evil.com` は new URL() で別オリジンに正規化される — codex FAIL #1)
 *   - 制御文字 (U+0000–U+001F, U+007F) を含む
 *
 * 値は既に URLSearchParams 等でデコード済みの前提なので、ここでは再デコードしない
 * (二重デコード回避)。最終リダイレクト側でも同一オリジンを再検証する (多層防御)。
 */
export function sanitizeRedirectPath(value: string | null | undefined): string {
  if (typeof value !== 'string' || value.length === 0) return '/';
  if (!value.startsWith('/')) return '/';
  if (value.startsWith('//')) return '/';
  if (value.includes('\\')) return '/';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return '/';
  }
  return value;
}
