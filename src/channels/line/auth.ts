/**
 * LINE Messaging API 認証ヘッダ生成
 *
 * 形式: `Bearer <channel_access_token (long-lived)>`
 *
 * 認証情報は Core API `/api/credentials/line_messaging?scope_key=<Channel ID>` 経由で取得し
 * (cs-manager 内に鍵をハードコード/env で持たない = Single Source of Truth は Core/Vault)、
 * このモジュールは「与えられた credentials から Bearer ヘッダを構築する」純関数のみを提供する。
 *
 * 受信 (verify.ts) は channel_secret、送信 (本ヘッダ) は channel_access_token を使う。
 */

export interface LineCredentials {
  /** vault 保管の canonical フィールド名 (snake_case)。 */
  channel_access_token?: string;
  /** 別名 (camelCase) も実態対応のため許容 (受信 route の channel_secret/channelSecret と同方針)。 */
  channelAccessToken?: string;
  /** 受信署名検証用 (本モジュールでは未使用、型の網羅性のため)。 */
  channel_secret?: string;
  display_name?: string;
}

/** credentials から `Bearer <token>` を構築する。token 欠落は throw。 */
export function buildLineAuthHeader(creds: LineCredentials): string {
  const token = (creds.channel_access_token ?? creds.channelAccessToken ?? '').replace(/\s+$/, '');
  if (!token) {
    throw new Error('line credential: channel_access_token is missing');
  }
  return `Bearer ${token}`;
}
