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
 * - ON: ユーザー向けページに Core ログイン + ロール (`REQUIRED_ROLE`) を要求。
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
 * Core 認証に必要な env (URL / anon key) が両方そろっているか。
 * フラグ ON でも env 未設定なら認証クライアントを生成すると throw するため、
 * 生成前のガードに使う。
 */
export function isCoreAuthConfigured(): boolean {
  return (
    !!process.env.NEXT_PUBLIC_CORE_SUPABASE_URL &&
    !!process.env.NEXT_PUBLIC_CORE_SUPABASE_ANON_KEY
  );
}

/**
 * cs-manager へのアクセスに必要な Core ロール。
 *
 * - middleware のページゲートで `user.app_metadata.roles` に含まれることを要求する。
 * - 同じ文字列を Supabase 側 RLS の `has_role('cs_manager')` ポリシーでも使う
 *   (ページ層と DB 層の認可セマンティクスを一致させるため)。
 */
export const REQUIRED_ROLE = 'cs_manager';

/**
 * Core の access token / user オブジェクトの app_metadata.roles から
 * 指定ロールを保持しているか判定する。
 *
 * roles は string[] を期待。未定義・型不正時は false。
 */
export function hasRole(
  appMetadata: Record<string, unknown> | null | undefined,
  role: string,
): boolean {
  const roles = appMetadata?.roles;
  if (!Array.isArray(roles)) return false;
  return roles.includes(role);
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
