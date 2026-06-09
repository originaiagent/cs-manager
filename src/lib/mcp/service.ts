/**
 * MCP サービス層 — cs-manager 自前の業務データ (customer_service_records) への
 * read / write wrapper。正本: minpaku-tool/src/mcp/service.ts。
 *
 * 原則 (B案):
 *   - 書込対象は cs-manager 自前の業務データ (customer_service_records.memo) のみ。
 *     Core master / 財務 / 他WSデータには触れない。
 *   - 永続化は cs-manager 自身の service_role クライアント (getSupabaseAdmin) 経由で行う。
 *     これは「自ツールの自前データへの自ツール service 経由 write」であり許容される
 *     (MCP から他ツール DB への service_role 直 write のみが禁止)。
 *
 * revision: customer_service_records.updated_at を唯一の楽観ロックソースとする。
 *   read / checkRevision / write 後 new_revision がすべて同じ updated_at を見ることで
 *   read→write→次の write のラウンドトリップが一貫する。
 */

import { getSupabaseAdmin } from '@/lib/db/supabase-admin';

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

export interface CustomerRecordRow {
  id: string;
  memo?: string | null;
  updated_at?: string | null;
  [key: string]: unknown;
}

export interface ServiceError {
  code: string;
  message: string;
  status: number;
}

export type ServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ServiceError };

// ---------------------------------------------------------------------------
// customer_record 操作
// ---------------------------------------------------------------------------

/** customer_service_records テーブルから1件読み取る */
export async function getCustomerRecord(id: string): Promise<ServiceResult<CustomerRecordRow>> {
  const sb = await getSupabaseAdmin();
  const { data, error } = await sb
    .from('customer_service_records')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    console.error('[mcp/service] getCustomerRecord error:', error.message);
    return { ok: false, error: { code: 'DB_ERROR', message: '対応記録の取得に失敗しました', status: 500 } };
  }
  if (!data) {
    return { ok: false, error: { code: 'NOT_FOUND', message: '対応記録が見つかりません', status: 404 } };
  }
  return { ok: true, data: data as CustomerRecordRow };
}

/**
 * customer_service_records を部分更新する。
 * cs-manager 自前 service_role 経由 (自ツールの自前データ更新)。
 * updated_at を明示セットし、handleRead / checkRevision と同じ revision ソースを更新する
 * (DB トリガ trg_csr_updated_at もあるが round-trip 一貫性のため明示)。
 *
 * 正本: minpaku-tool patchProperty / patchVendor の atomic CAS パターン。
 * expected_revision を指定した場合は **atomic CAS**: `.eq('updated_at', expected_revision)` を
 * 条件に加え、affected rows が 0 件なら OCC 衝突 (code='REVISION_CONFLICT') を返す。
 * これにより別 idempotency_key の同時 write が同じ revision を読んで両方 apply する競合を防ぐ。
 * expected_revision 未指定時は従来通り CAS 条件なし (legacy 挙動完全維持)。
 */
export async function patchCustomerRecord(
  id: string,
  updates: Partial<Omit<CustomerRecordRow, 'id'>>,
  expected_revision?: string,
): Promise<ServiceResult<CustomerRecordRow>> {
  if (Object.keys(updates).length === 0) {
    return { ok: false, error: { code: 'NO_FIELDS', message: '更新フィールドがありません', status: 400 } };
  }

  const sb = await getSupabaseAdmin();
  let q = sb
    .from('customer_service_records')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id);
  // CAS: expected_revision 指定時のみ updated_at 一致を条件に追加 (atomic OCC)
  if (expected_revision !== undefined) {
    q = q.eq('updated_at', expected_revision);
  }
  // 0 件判定のため .maybeSingle() は使わず affected rows を select で確認する
  const { data, error } = await q.select('*');

  if (error) {
    console.error('[mcp/service] patchCustomerRecord error:', error.message);
    return { ok: false, error: { code: 'DB_ERROR', message: '更新に失敗しました', status: 500 } };
  }
  if (!data || data.length === 0) {
    // CAS 指定時の 0 件は OCC 衝突 (revision がズレた)。未指定時の 0 件は対象不在。
    if (expected_revision !== undefined) {
      return { ok: false, error: { code: 'REVISION_CONFLICT', message: '楽観ロック衝突: revision が一致しません', status: 409 } };
    }
    return { ok: false, error: { code: 'NOT_FOUND', message: '対応記録が見つかりません', status: 404 } };
  }
  return { ok: true, data: data[0] as CustomerRecordRow };
}

// ---------------------------------------------------------------------------
// ai_embed_form_gates — write_enabled ゲート
// ---------------------------------------------------------------------------

/**
 * form_id の write_enabled を確認する。
 * テーブルが存在しない / 行が無い / エラーの場合は false (fail-closed)。
 */
export async function isFormWriteEnabled(form_id: string): Promise<boolean> {
  try {
    const sb = await getSupabaseAdmin();
    const { data, error } = await sb
      .from('ai_embed_form_gates')
      .select('write_enabled')
      .eq('form_id', form_id)
      .maybeSingle();
    if (error || !data) return false;
    return data.write_enabled === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// ai_embed_idempotency — 冪等キー管理 (INSERT-first 予約 + status lifecycle)
// ---------------------------------------------------------------------------

export interface IdempotencyRecord {
  idempotency_key: string;
  run_id: string;
  result_json: unknown;
  status: 'pending' | 'completed';
  created_at: string;
}

export type CheckIdempotencyResult =
  | { status: 'hit'; record: IdempotencyRecord }       // 同一 run_id + completed: リプレイ可
  | { status: 'processing' }                            // 同一 run_id + pending: apply 進行中
  | { status: 'conflict'; run_id: string }              // 別 run_id: リプレイ不可
  | { status: 'miss' };                                 // 未登録

/**
 * 冪等キーを確認する。
 * - 行なし                          → 'miss'
 * - 同 run_id + status='completed'  → 'hit'
 * - 同 run_id + status='pending'    → 'processing'
 * - 異なる run_id                   → 'conflict'
 * 例外時は fail-closed で 'miss' (reserve に進み DB の unique で弾く)。
 */
export async function checkIdempotencyKey(
  idempotency_key: string,
  run_id: string,
): Promise<CheckIdempotencyResult> {
  try {
    const sb = await getSupabaseAdmin();
    const { data } = await sb
      .from('ai_embed_idempotency')
      .select('*')
      .eq('idempotency_key', idempotency_key)
      .maybeSingle();
    if (!data) return { status: 'miss' };
    const record = data as IdempotencyRecord;
    if (record.run_id !== run_id) {
      return { status: 'conflict', run_id: record.run_id };
    }
    if (record.status !== 'completed') {
      return { status: 'processing' };
    }
    return { status: 'hit', record };
  } catch {
    return { status: 'miss' };
  }
}

export type ReserveResult =
  | { status: 'reserved' }
  | { status: 'conflict' };

/**
 * 冪等キーを INSERT-first で予約する。
 * idempotency_key は PRIMARY KEY なので並行 INSERT の一方は unique violation になる。
 * 成功 → owner として apply 続行 / conflict → 既に予約済みで apply 不可。
 */
export async function reserveIdempotencyKey(
  idempotency_key: string,
  run_id: string,
): Promise<ReserveResult> {
  try {
    const sb = await getSupabaseAdmin();
    const { error } = await sb.from('ai_embed_idempotency').insert({
      idempotency_key,
      run_id,
      result_json: {},
      status: 'pending',
      created_at: new Date().toISOString(),
    });

    if (error) {
      if (error.code === '23505') {
        return { status: 'conflict' };
      }
      console.error('[mcp/service] reserveIdempotencyKey insert error:', error.message);
      return { status: 'conflict' };
    }
    return { status: 'reserved' };
  } catch (e) {
    console.error('[mcp/service] reserveIdempotencyKey unexpected error:', (e as Error).message);
    return { status: 'conflict' };
  }
}

/** apply 成功後に result_json を UPDATE し status を 'completed' にする。 */
export async function updateIdempotencyResult(
  idempotency_key: string,
  result_json: unknown,
): Promise<void> {
  try {
    const sb = await getSupabaseAdmin();
    await sb
      .from('ai_embed_idempotency')
      .update({ result_json, status: 'completed' })
      .eq('idempotency_key', idempotency_key);
  } catch (e) {
    console.error('[mcp/service] updateIdempotencyResult error:', (e as Error).message);
  }
}

/** apply 失敗後に pending 予約行を DELETE し正当な再試行を許可する (completed は保護)。 */
export async function releaseIdempotencyKey(idempotency_key: string): Promise<void> {
  try {
    const sb = await getSupabaseAdmin();
    await sb
      .from('ai_embed_idempotency')
      .delete()
      .eq('idempotency_key', idempotency_key)
      .eq('status', 'pending');
  } catch (e) {
    console.error('[mcp/service] releaseIdempotencyKey error:', (e as Error).message);
  }
}
