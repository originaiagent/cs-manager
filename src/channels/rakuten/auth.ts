/**
 * 楽天 RMS 認証ヘッダ生成
 *
 * 形式: `ESA <base64(serviceSecret:licenseKey)>`
 *
 * Phase 4 で Core API `/api/credentials/rakuten_rmesse` 経由に切り替え。
 * cs-manager 内に楽天認証情報をハードコード or env で持たない (Single Source of Truth = Core/Vault)。
 *
 * credential 取得は呼び出し側 (adapter / outbound) で `getCredential('rakuten_rmesse', shopId)` を実行し、
 * このモジュールは「与えられた credentials から ESA ヘッダを構築する」純関数のみを提供する。
 */

export interface RakutenCredentials {
  /** vault.secrets に保管されている credentials JSON のフィールド名は `service_secret` (snake_case) */
  service_secret: string;
  license_key: string;
  /** 取得 API のレスポンスに含まれるが ESA ヘッダ生成には不要 (将来用) */
  rms_user?: string;
  dev_auth_key?: string;
}

export function buildRakutenAuthHeader(creds: RakutenCredentials): string {
  if (!creds.service_secret) throw new Error('rakuten credential: service_secret is missing');
  if (!creds.license_key) throw new Error('rakuten credential: license_key is missing');
  const raw = `${creds.service_secret}:${creds.license_key}`;
  const b64 = Buffer.from(raw, 'utf8').toString('base64');
  return `ESA ${b64}`;
}
