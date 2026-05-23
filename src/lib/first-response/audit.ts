/**
 * 一次返信フロー — send_audit 記録 (raw PII / rendered body を保持しない)
 *
 * codex CONCERN #5: send_audit には rendered body や顧客名をそのまま残さない。
 *   - 差込値はマスク済みのみ (masked_placeholders)
 *   - rendered body は HMAC ハッシュ (body_hash) のみ。内容は復元不可
 *   - 失敗エラーはサニタイズ (raw PII を含めない、1000 字トリム)
 *
 * HMAC 鍵は Core credential 経由で解決 (cs-manager 内に鍵を持たない)。鍵未設定時は
 * body_hash を null にし、ハッシュ自体を諦める (raw を残すよりは安全)。
 */

import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getCredential } from '@/lib/credentials';

export type SendAuditResult =
  | 'dry_run'
  | 'sent'
  | 'failed'
  | 'skipped'
  | 'blocked';

export interface SendAuditInput {
  ticketId: string;
  draftId?: string | null;
  channelId?: string | null;
  channelCode?: string | null;
  category?: string | null;
  templateId?: string | null;
  templateVersion?: number | null;
  result: SendAuditResult;
  /** マスク済み差込値のみ ({"customer_name":"<token>", ...})。raw は入れない */
  maskedPlaceholders?: Record<string, string>;
  /** rendered body の HMAC ハッシュ用 (本文そのものは保存しない) */
  bodyForHash?: string | null;
  /** flag / 営業時間判定等のスナップショット (鍵・raw 値は含めない) */
  configSnapshot?: Record<string, unknown>;
  externalMessageId?: string | null;
  /** サニタイズ済みエラー (呼び出し側で raw PII を除いてから渡す) */
  errorSanitized?: string | null;
  /** HMAC 鍵の Core credential service_code (rag_config 駆動) */
  hmacServiceCode?: string | null;
}

/** rendered body を HMAC-SHA256 でハッシュ化。鍵未解決時は null。 */
async function hmacBody(
  body: string | null | undefined,
  serviceCode: string | null | undefined,
): Promise<string | null> {
  if (!body || !serviceCode) return null;
  try {
    const cred = await getCredential<{ key?: string; secret?: string; api_key?: string }>(
      serviceCode,
    );
    const secret = cred.credentials?.key ?? cred.credentials?.secret ?? cred.credentials?.api_key;
    if (!secret) return null;
    return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  } catch {
    // 鍵解決失敗時はハッシュを諦める (raw を残さない方を優先)
    return null;
  }
}

export async function recordSendAudit(
  sb: SupabaseClient,
  input: SendAuditInput,
): Promise<void> {
  const bodyHash = await hmacBody(input.bodyForHash, input.hmacServiceCode);
  const { error } = await sb.from('send_audit').insert({
    ticket_id: input.ticketId,
    draft_id: input.draftId ?? null,
    channel_id: input.channelId ?? null,
    channel_code: input.channelCode ?? null,
    flow: 'first_response',
    category: input.category ?? null,
    template_id: input.templateId ?? null,
    template_version: input.templateVersion ?? null,
    result: input.result,
    masked_placeholders: input.maskedPlaceholders ?? {},
    body_hash: bodyHash,
    config_snapshot: input.configSnapshot ?? {},
    external_message_id: input.externalMessageId ?? null,
    error_sanitized: input.errorSanitized ? input.errorSanitized.slice(0, 1000) : null,
  });
  // audit 失敗はフロー全体を止めない (送信は既に確定している可能性がある) が、warn は出す
  if (error) console.warn(`recordSendAudit failed: ${error.message}`);
}
