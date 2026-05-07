/**
 * 楽天 RMS 認証ヘッダ生成
 *
 * 形式: `ESA <base64(serviceSecret:licenseKey)>`
 * ec-manager (server/rakuten-api.ts:getAuthHeader) のパターンを踏襲。
 *
 * Phase 1.1 では env から取得。Phase 4 で channel_credentials テーブル + Vault 化予定。
 */

export interface RakutenCredentials {
  serviceSecret: string;
  licenseKey: string;
}

export function getRakutenCredentials(): RakutenCredentials {
  const serviceSecret = process.env.RAKUTEN_SERVICE_SECRET;
  const licenseKey = process.env.RAKUTEN_LICENSE_KEY;
  if (!serviceSecret) throw new Error('RAKUTEN_SERVICE_SECRET is not set');
  if (!licenseKey) throw new Error('RAKUTEN_LICENSE_KEY is not set');
  return { serviceSecret, licenseKey };
}

export function buildRakutenAuthHeader(creds: RakutenCredentials): string {
  const raw = `${creds.serviceSecret}:${creds.licenseKey}`;
  const b64 = Buffer.from(raw, 'utf8').toString('base64');
  return `ESA ${b64}`;
}
