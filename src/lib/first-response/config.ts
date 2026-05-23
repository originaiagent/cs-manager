/**
 * 営業時間外一次返信フロー — DB 駆動の設定読み出し (rag_config)
 *
 * ハードコード禁止 (CLAUDE.md コーディング規約): flag / model / 文言 / fallback category は
 * すべて cs DB の rag_config から取得する。env や定数に焼かない。
 *
 * rag_config.config_value は JSONB (scalar JSON が多い)。例:
 *   first_response_enabled = false (boolean)
 *   first_response_default_category = "general" (string)
 *   first_response_next_business_day_note = "※ ..." (string)
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface FirstResponseConfig {
  /** フロー全体の有効化 (既定 false=投入時無効) */
  enabled: boolean;
  /** 営業時間外 R-MessE 自動送信 flag (既定 false=dry-run) */
  rakutenAutoSendEnabled: boolean;
  /** AI 分類失敗時の fallback category */
  defaultCategory: string;
  /** 分類モデル (origin-ai 側 skill が解決。ここでは記録/受け渡し用) */
  classifyModel: string | null;
  /** 末尾に付与する翌営業日連絡の定型文 */
  nextBusinessDayNote: string;
  /** send_audit body_hash 用 HMAC 鍵の Core credential service_code */
  auditHmacServiceCode: string | null;
}

const KEYS = [
  'first_response_enabled',
  'rakuten_auto_send_enabled',
  'first_response_default_category',
  'first_response_classify_model',
  'first_response_next_business_day_note',
  'first_response_audit_hmac_service_code',
] as const;

function asBool(v: unknown): boolean {
  // JSONB scalar: true / false / "true" のいずれも安全側 (false 既定) で解釈
  if (v === true) return true;
  if (typeof v === 'string') return v.trim().toLowerCase() === 'true';
  return false;
}

function asString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v == null) return null;
  return String(v);
}

/**
 * rag_config から一次返信フロー設定をまとめて取得する。
 * fail-closed: 取得失敗 / 欠落キーは「無効・自動送信なし」側に倒す。
 */
export async function loadFirstResponseConfig(
  sb: SupabaseClient,
): Promise<FirstResponseConfig> {
  const map = new Map<string, unknown>();
  const { data, error } = await sb
    .from('rag_config')
    .select('config_key, config_value')
    .in('config_key', KEYS as unknown as string[]);
  if (!error) {
    for (const row of data ?? []) {
      map.set(
        (row as { config_key: string }).config_key,
        (row as { config_value: unknown }).config_value,
      );
    }
  }

  return {
    // fail-closed: キー欠落・読み取り失敗時は無効
    enabled: asBool(map.get('first_response_enabled')),
    rakutenAutoSendEnabled: asBool(map.get('rakuten_auto_send_enabled')),
    defaultCategory: asString(map.get('first_response_default_category')) || 'general',
    classifyModel: asString(map.get('first_response_classify_model')),
    nextBusinessDayNote:
      asString(map.get('first_response_next_business_day_note')) || '',
    auditHmacServiceCode: asString(
      map.get('first_response_audit_hmac_service_code'),
    ),
  };
}

/** 許可カテゴリ (template.category と一致させる)。AI 分類結果のバリデーションに使用。 */
export const ALLOWED_CATEGORIES = [
  'general',
  'complaint',
  'inquiry',
  'urgent',
] as const;
export type FirstResponseCategory = (typeof ALLOWED_CATEGORIES)[number];

export function normalizeCategory(
  raw: string | null | undefined,
  fallback: string,
): string {
  const v = (raw ?? '').trim().toLowerCase();
  if ((ALLOWED_CATEGORIES as readonly string[]).includes(v)) return v;
  return (ALLOWED_CATEGORIES as readonly string[]).includes(fallback)
    ? fallback
    : 'general';
}
