/**
 * Core (origin-core) を IdP とする Third-Party Auth (JWKS) のユーザー認証設定。
 *
 * このファイルはサーバ/ブラウザ双方から import される純粋な定数・ヘルパのみを持つ
 * (env 直参照やクライアント生成は別ファイル)。
 */

/**
 * ユーザー認証ゲートの ON/OFF フラグ。
 *
 * - 既定 OFF: middleware は素通し = 現行 (ユーザーログイン無し) の挙動を完全維持。
 * - ON: ユーザー向けページに Core ログイン + tool_access (`TOOL_KEY`) を要求。
 *
 * 重要: cs-manager 側 Supabase に JWKS provider 未登録の状態で ON にすると
 * 全ユーザーがロックアウトされるため、provider 登録後にのみ ON にする運用。
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
 *     キーが存在しない場合は false 扱い (absent = false)。
 *   - `app_metadata.is_admin` は boolean。
 *
 * - middleware のページゲートで `user.app_metadata.tool_access['cs-manager'] === true`
 *   を要求する。
 * - 同じキーを Supabase 側 RLS の `has_tool_access('cs-manager')` ポリシーでも使う
 *   (ページ層と DB 層の認可セマンティクスを一致させるため)。
 */
export const TOOL_KEY = 'cs-manager';

/**
 * Core の access token / user オブジェクトの app_metadata.tool_access から
 * cs-manager のアクセス権を持つか判定する (fail-closed)。
 *
 * tool_access は { [toolKey]: boolean } を期待。
 * 厳密に `tool_access['cs-manager'] === true` のときのみ許可。
 * 未定義・型不正 (配列含む)・欠如・true 以外の値は全て false。
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
 * オープンリダイレクト防止: 同一オリジンの相対パスのみ許可する。
 *
 * - `/` で始まり、かつ `//` (プロトコル相対 → 別オリジン) で始まらないものだけ通す。
 * - それ以外は既定 `/` にフォールバック。
 */
export function sanitizeRedirectPath(value: string | null | undefined): string {
  if (typeof value !== 'string') return '/';
  if (!value.startsWith('/')) return '/';
  if (value.startsWith('//')) return '/';
  return value;
}
