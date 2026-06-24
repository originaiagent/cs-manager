'use client';

/**
 * Server Action 呼び出しの「認証切れ」復帰ヘルパ (client 専用)。
 *
 * 背景: ユーザーのセッションが切れた状態で client から Server Action を呼ぶと、
 * 認証 middleware が 401/403 を返す (middleware.ts: actionAuthResponse)。Next.js 14.2 では
 * この応答の body は action の戻り値として client に渡らず、action dispatch が throw するか
 * 戻り値なし (null/undefined) になる。呼び出し側がこれを捕捉しないと、loading 状態が解除されず
 * UI が無限ローディングのまま固着する (本不具合の表層症状)。
 *
 * → 全 client Server Action 呼び出しは runAction() で包み、authExpired を検知したら
 *   ローディングを解除し、エラー表示 + 再ログインリンク (loginHrefForHere) で復帰する。
 *
 * 方針: 認証切れ時に /login へ自動遷移はしない。入力中フォーム (返信本文 / 記事 / 記録) の
 * 内容が失われるため、エラー表示 + リンク提示に留める (データ保全優先)。
 */

/** 認証切れ時にユーザーへ提示する標準メッセージ。 */
export const AUTH_EXPIRED_MESSAGE =
  'セッションが切れた可能性があります。再ログインしてからもう一度お試しください。';

/**
 * 現在地を redirect に載せた /login への href を返す (client 専用)。
 * 再ログイン後に元のページへ戻れるようにする。
 */
export function loginHrefForHere(): string {
  if (typeof window === 'undefined') return '/login';
  const here = window.location.pathname + window.location.search;
  return `/login?redirect=${encodeURIComponent(here)}`;
}

/** runAction の結果。authExpired=true のとき result は無い。 */
export type ActionRunResult<T> =
  | { authExpired: true }
  | { authExpired: false; result: T };

/**
 * Server Action 呼び出しを包み、認証切れ (throw もしくは戻り値なし) を authExpired として
 * 正常復帰させる。通常のアプリエラーは action 側が `{ ok: false }` 等で値として返す契約のため、
 * ここで throw / null になるのは「action 本体に到達しなかった」= 認証/インフラ要因とみなす。
 *
 * @example
 *   const r = await runAction(() => generateRagDraft(ticketId));
 *   if (r.authExpired) { setError(AUTH_EXPIRED_MESSAGE); return; }
 *   const result = r.result; // 通常の {ok:...} 値
 */
export async function runAction<T>(fn: () => Promise<T>): Promise<ActionRunResult<T>> {
  let value: T;
  try {
    value = await fn();
  } catch {
    return { authExpired: true };
  }
  if (value == null) return { authExpired: true };
  return { authExpired: false, result: value };
}
