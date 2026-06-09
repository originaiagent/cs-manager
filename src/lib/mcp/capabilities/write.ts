/**
 * MCP capability: write — cs-manager (customer_record / memo)
 * 正本: minpaku-tool/src/mcp/capabilities/write.ts。
 *
 * customer_record フォームは scalar text place (memo) のみを持つため、
 * サポートする op は 'set' のみ。create-place / delete-place / reorder-place は拒否する。
 *
 * §2.3 準拠:
 * - 永続化は cs-manager 自前 service 層経由 (service.ts → getSupabaseAdmin)。
 * - フォーム単位 validate-all-then-apply + 失敗時 revert (prior 値キャプチャ)。
 * - expected_revision: customer_service_records.updated_at と比較する楽観ロック。
 * - dry_run: 検証のみ、永続化しない。
 * - idempotency_key: ai_embed_idempotency で INSERT-first 予約 + status lifecycle。
 * - ai_embed_form_gates で write_enabled を確認 (false → live write 拒否)。
 */

import { getForm, getPlace } from '@/lib/mcp/manifest';
import {
  isFormWriteEnabled,
  checkIdempotencyKey,
  reserveIdempotencyKey,
  updateIdempotencyResult,
  releaseIdempotencyKey,
  getCustomerRecord,
  patchCustomerRecord,
} from '@/lib/mcp/service';

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

export type WriteOpKind = 'set' | 'create-place' | 'delete-place' | 'reorder-place';

export interface WriteOpSet {
  kind: 'set';
  place_id: string;
  value: unknown;
  index?: number;
}

export interface WriteOpCreate {
  kind: 'create-place';
  group_place_id: string;
  value: Record<string, unknown>;
}

export interface WriteOpDelete {
  kind: 'delete-place';
  group_place_id: string;
  index: number;
}

export interface WriteOpReorder {
  kind: 'reorder-place';
  group_place_id: string;
  from: number;
  to: number;
}

export type WriteOp = WriteOpSet | WriteOpCreate | WriteOpDelete | WriteOpReorder;

export interface WriteInput {
  form_id: string;
  ops: WriteOp[];
  dry_run: boolean;
  idempotency_key: string;
  expected_revision?: string;
  provenance: { source: string; run_id: string; extracted_from?: string };
  confidence?: number;
}

export interface AppliedOp {
  op: WriteOp;
  result: unknown;
}

export type WriteResult =
  | { ok: true; form_id: string; applied: AppliedOp[]; new_revision: string }
  | { ok: false; rejected_op: WriteOp | null; reason: string; current_revision?: string };

// ---------------------------------------------------------------------------
// バリデーション (dry_run でも実行される)
// ---------------------------------------------------------------------------

interface ValidationError {
  op: WriteOp;
  reason: string;
}

function validateOps(form_id: string, ops: WriteOp[]): ValidationError | null {
  const form = getForm(form_id);
  if (!form) return { op: ops[0], reason: `form_id "${form_id}" は manifest に定義されていません` };

  for (const op of ops) {
    // customer_record は scalar text place のみ。set 以外は未サポート。
    if (op.kind !== 'set') {
      return {
        op,
        reason: `op "${op.kind}" は customer_record フォームでは未サポートです (set のみ)`,
      };
    }

    const place = getPlace(form_id, op.place_id);
    if (!place) {
      return { op, reason: `place_id "${op.place_id}" は manifest に定義されていません` };
    }
    if (!place.writable) {
      return { op, reason: `place_id "${op.place_id}" は読み取り専用です` };
    }
    const typeError = validatePlaceValue(place.type, op.value, place);
    if (typeError) return { op, reason: typeError };
  }

  return null;
}

function validatePlaceValue(
  type: string,
  value: unknown,
  place: ReturnType<typeof getPlace>,
): string | null {
  if (value === null || value === undefined) return null; // null クリアは許可

  switch (type) {
    case 'number':
      if (typeof value !== 'number') return `number 型が必要です`;
      if (place?.validation?.min != null && (value as number) < place.validation.min) {
        return `値が min (${place.validation.min}) 未満です`;
      }
      if (place?.validation?.max != null && (value as number) > place.validation.max) {
        return `値が max (${place.validation.max}) を超えています`;
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return `boolean 型が必要です`;
      break;
    case 'text':
    case 'date':
    case 'lookup':
      if (typeof value !== 'string') return `string 型が必要です`;
      if (place?.validation?.maxLength != null && (value as string).length > place.validation.maxLength) {
        return `文字数が maxLength (${place.validation.maxLength}) を超えています`;
      }
      if (place?.validation?.pattern) {
        if (!new RegExp(place.validation.pattern).test(value as string)) {
          return `pattern "${place.validation.pattern}" にマッチしません`;
        }
      }
      break;
    case 'enum':
      if (typeof value !== 'string') return `string 型が必要です`;
      if (place?.enum && !place.enum.some((e) => e.value === value)) {
        return `enum 値が不正です: "${value}"`;
      }
      break;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 楽観ロック確認 — customer_service_records.updated_at
// ---------------------------------------------------------------------------

async function checkRevision(
  target_id: string,
  expected_revision: string,
): Promise<{ ok: true; current_revision: string } | { ok: false; current_revision: string }> {
  const r = await getCustomerRecord(target_id);
  if (!r.ok) return { ok: false, current_revision: '' };
  const current_revision = r.data.updated_at ?? '';
  if (current_revision !== expected_revision) {
    return { ok: false, current_revision };
  }
  return { ok: true, current_revision };
}

// ---------------------------------------------------------------------------
// 単一 op 適用 (customer_record)
// ---------------------------------------------------------------------------

async function applyCustomerRecordOp(
  target_id: string,
  op: WriteOp,
): Promise<{ ok: true; result: unknown } | { ok: false; reason: string }> {
  if (op.kind !== 'set') {
    return { ok: false, reason: `customer_record フォームは ${op.kind} をサポートしていません` };
  }
  const result = await patchCustomerRecord(target_id, { [op.place_id]: op.value });
  if (!result.ok) return { ok: false, reason: result.error.message };
  return { ok: true, result: result.data };
}

// ---------------------------------------------------------------------------
// [P1] scalar set バッチ適用 — 同一 row への複数 scalar set を単一 CAS で atomic 適用
// ---------------------------------------------------------------------------

/**
 * 正本: minpaku-tool applyScalarSetBatch。
 * 同一 row (customer_service_records) への複数 scalar set op を **1 回の patch にまとめて単一 CAS** で
 * atomic に適用する。従来の「op 毎逐次 patch + 失敗時 prior 書戻し (非CAS rollback)」が
 * 抱えていた競合 (rollback が間に入った別 write を非CASで上書き) を根絶する。
 * 単一 update なので部分適用が発生せず、CAS 0 件なら全体が未適用のまま fail (rollback 不要)。
 *
 * @param expected_revision  指定時のみ CAS (updated_at 条件)。未指定時は CAS なし (legacy 同等 + atomic)。
 * @returns ok=true: 更新後の row。conflict=true: CAS 0 件 (REVISION_CONFLICT)。
 */
async function applyScalarSetBatch(
  target_id: string,
  setOps: WriteOpSet[],
  expected_revision?: string,
): Promise<{ ok: true; row: Record<string, unknown> } | { ok: false; reason: string; conflict?: boolean }> {
  // 同一 op 配列内で同じ place_id への set が複数ある場合は後勝ち (配列順) で統合する。
  const merged: Record<string, unknown> = {};
  for (const op of setOps) merged[op.place_id] = op.value;

  const result = await patchCustomerRecord(target_id, merged, expected_revision);
  if (!result.ok) {
    return { ok: false, reason: result.error.message, conflict: result.error.code === 'REVISION_CONFLICT' };
  }
  return { ok: true, row: result.data as unknown as Record<string, unknown> };
}

/**
 * scalar set op 判定。customer_record は memo (text) のみが scalar。
 * child item ("memo.x") や documents 等は持たないが、minpaku と同様 manifest 型で厳密判定する。
 */
function isScalarSetOp(form_id: string, op: WriteOp): op is WriteOpSet {
  if (op.kind !== 'set') return false;
  if (op.place_id.includes('.')) return false;
  const place = getPlace(form_id, op.place_id);
  return place !== undefined && place.type !== 'file' && place.type !== 'repeating';
}

// ---------------------------------------------------------------------------
// リバート (失敗時ロールバック) — set の prior_value 復元
// ---------------------------------------------------------------------------

interface AppliedOpWithPrior {
  op: WriteOp;
  result: unknown;
  prior: { kind: 'set'; place_id: string; prior_value: unknown };
}

async function revertAppliedWithPrior(
  target_id: string,
  applied: AppliedOpWithPrior[],
): Promise<void> {
  for (const { prior } of [...applied].reverse()) {
    try {
      if (prior.kind === 'set') {
        await patchCustomerRecord(target_id, { [prior.place_id]: prior.prior_value });
      }
    } catch (revertErr) {
      console.error('[mcp/write] revert 失敗 (best-effort):', (revertErr as Error).message);
    }
  }
}

// ---------------------------------------------------------------------------
// メイン write ハンドラ
// ---------------------------------------------------------------------------

export async function handleWrite(
  input: WriteInput,
  target_id: string,
  run_id: string,
): Promise<WriteResult> {
  const form = getForm(input.form_id);
  if (!form) {
    return { ok: false, rejected_op: null, reason: `form_id "${input.form_id}" は manifest に定義されていません` };
  }

  // write_enabled ゲート確認 (dry_run はスキップ)
  const writeEnabled = await isFormWriteEnabled(input.form_id);
  if (!writeEnabled && !input.dry_run) {
    return { ok: false, rejected_op: null, reason: `フォーム "${input.form_id}" は write が無効です (contract test 未通過)` };
  }

  // 冪等キー確認 + 予約 (dry_run は skip)
  if (!input.dry_run) {
    const checkResult = await checkIdempotencyKey(input.idempotency_key, run_id);
    if (checkResult.status === 'hit') {
      return checkResult.record.result_json as WriteResult;
    }
    if (checkResult.status === 'processing') {
      return {
        ok: false,
        rejected_op: null,
        reason: `idempotency_key "${input.idempotency_key}" は処理中です。apply 完了を待ってから同じキーで再試行してください。`,
      };
    }
    if (checkResult.status === 'conflict') {
      return {
        ok: false,
        rejected_op: null,
        reason: `idempotency_key "${input.idempotency_key}" は別の run で使用済みです。key を変更してください。`,
      };
    }
    const reserve = await reserveIdempotencyKey(input.idempotency_key, run_id);
    if (reserve.status === 'conflict') {
      return {
        ok: false,
        rejected_op: null,
        reason: `idempotency_key "${input.idempotency_key}" は処理中です。少し待ってから同じキーで再試行してください。`,
      };
    }
  }

  // 楽観ロック確認
  if (input.expected_revision) {
    const revResult = await checkRevision(target_id, input.expected_revision);
    if (!revResult.ok) {
      if (!input.dry_run) await releaseIdempotencyKey(input.idempotency_key);
      return {
        ok: false,
        rejected_op: null,
        reason: '楽観ロック衝突: revision が一致しません',
        current_revision: revResult.current_revision,
      };
    }
  }

  // 全 ops バリデーション
  const validationError = validateOps(input.form_id, input.ops);
  if (validationError) {
    if (!input.dry_run) await releaseIdempotencyKey(input.idempotency_key);
    return { ok: false, rejected_op: validationError.op, reason: validationError.reason };
  }

  // dry_run: ここで終了
  if (input.dry_run) {
    return {
      ok: true,
      form_id: input.form_id,
      applied: input.ops.map((op) => ({ op, result: null })),
      new_revision: 'dry_run',
    };
  }

  // Apply 全 ops — prior 値をキャプチャしてから apply。
  // [P2 修正1] scalar set の new_revision は apply 後の別 read ではなく
  // patch が返した更新行の updated_at から導出する (別 write による after_revision ズレ防止)。
  const appliedWithPrior: AppliedOpWithPrior[] = [];
  let lastScalarUpdatedAt: string | undefined;

  // [P1] batch 単一 CAS 経路は「全 op が同一 row の scalar set」の write のときだけ使う。
  // - reversible flow は reversibleSetOps で常に scalar set のみ → 常にこの経路 (atomic)。
  // - pure-scalar legacy write も同経路。
  // それ以外 (構造 op を含む / 非 set) は従来逐次 per-op + rollback 経路に戻す (legacy 完全維持)。
  const allScalarSameRow = input.ops.length > 0 && input.ops.every((op) => isScalarSetOp(input.form_id, op));

  let applied: AppliedOp[];

  if (allScalarSameRow) {
    // ════════════════════════════════════════════════════════════════════════
    // 経路 A: pure-scalar (全 op 同一 row scalar set) — 単一 CAS で atomic 適用
    // ════════════════════════════════════════════════════════════════════════
    const scalarSetOps = input.ops as WriteOpSet[];

    // apply 前に全 scalar フィールドの prior 値を 1 回の read でまとめてキャプチャ (fail-closed)。
    const priorValues: Record<string, unknown> = {};
    try {
      const r = await getCustomerRecord(target_id);
      const row = r.ok ? (r.data as unknown as Record<string, unknown>) : null;
      for (const op of scalarSetOps) priorValues[op.place_id] = row ? row[op.place_id] ?? null : null;
    } catch (readErr) {
      console.error('[mcp/write] scalar batch prior 読み取り失敗 (fail-closed):', (readErr as Error).message);
      await releaseIdempotencyKey(input.idempotency_key);
      return { ok: false, rejected_op: scalarSetOps[0], reason: `apply 前の状態読み取りに失敗しました: ${(readErr as Error).message}` };
    }

    // 単一 CAS update。expected_revision 指定時のみ CAS、未指定時は CAS なし (legacy 同等 + atomic)。
    const batch = await applyScalarSetBatch(target_id, scalarSetOps, input.expected_revision);
    if (!batch.ok) {
      // 単一 update なので部分適用なし → rollback 不要。pending 解放のみ。
      await releaseIdempotencyKey(input.idempotency_key);
      if (batch.conflict) {
        return { ok: false, rejected_op: scalarSetOps[0], reason: '楽観ロック衝突: revision が一致しません', current_revision: '' };
      }
      return { ok: false, rejected_op: scalarSetOps[0], reason: batch.reason };
    }

    void priorValues; // 部分適用が発生しないため batch revert は不要
    lastScalarUpdatedAt = (batch.row.updated_at as string | undefined) ?? undefined;
    applied = scalarSetOps.map((op) => ({ op, result: batch.row }));
  } else {
    // ════════════════════════════════════════════════════════════════════════
    // 経路 B: 非 scalar set を含む — 従来逐次 per-op + rollback (legacy 完全同一・CAS なし)
    // ════════════════════════════════════════════════════════════════════════
    try {
      for (const op of input.ops) {
        if (op.kind !== 'set') {
          await revertAppliedWithPrior(target_id, appliedWithPrior);
          await releaseIdempotencyKey(input.idempotency_key);
          return { ok: false, rejected_op: op, reason: `op "${op.kind}" は未サポートです` };
        }

        // apply 前に prior 値を読み取る
        let prior: AppliedOpWithPrior['prior'];
        try {
          const r = await getCustomerRecord(target_id);
          const prior_value = r.ok ? (r.data as Record<string, unknown>)[op.place_id] ?? null : null;
          prior = { kind: 'set', place_id: op.place_id, prior_value };
        } catch (readErr) {
          console.error('[mcp/write] prior 読み取り失敗 (fail-closed):', (readErr as Error).message);
          await revertAppliedWithPrior(target_id, appliedWithPrior);
          await releaseIdempotencyKey(input.idempotency_key);
          return { ok: false, rejected_op: op, reason: `apply 前の状態読み取りに失敗しました: ${(readErr as Error).message}` };
        }

        // 経路 B は CAS を渡さない (legacy 完全同一)。OCC は preflight checkRevision のみ。
        const opResult = await applyCustomerRecordOp(target_id, op);
        if (!opResult.ok) {
          await revertAppliedWithPrior(target_id, appliedWithPrior);
          await releaseIdempotencyKey(input.idempotency_key);
          return { ok: false, rejected_op: op, reason: opResult.reason };
        }

        const updatedRow = opResult.result as Record<string, unknown> | null;
        const updatedAt = (updatedRow?.updated_at as string | undefined) ?? undefined;
        if (updatedAt) lastScalarUpdatedAt = updatedAt;

        appliedWithPrior.push({ op, result: opResult.result, prior });
      }
    } catch (unexpectedErr) {
      console.error('[mcp/write] apply ループ内で予期せぬエラー (fail-closed):', (unexpectedErr as Error).message);
      await revertAppliedWithPrior(target_id, appliedWithPrior);
      await releaseIdempotencyKey(input.idempotency_key);
      return {
        ok: false,
        rejected_op: null,
        reason: `予期せぬエラーが発生しました: ${(unexpectedErr as Error).message}`,
      };
    }

    applied = appliedWithPrior.map(({ op, result }) => ({ op, result }));
  }

  // [P2 修正1] 新しい revision は patch が返した更新行の updated_at (lastScalarUpdatedAt) を使う。
  // 別 read を廃止し、間に別 write が入って after_revision がズレるのを防ぐ。
  // フォールバック (想定外で updated_at が無い場合) は従来の read。
  let new_revision = new Date().toISOString();
  if (lastScalarUpdatedAt) {
    new_revision = lastScalarUpdatedAt;
  } else {
    const r = await getCustomerRecord(target_id);
    if (r.ok) new_revision = r.data.updated_at ?? new_revision;
  }

  const result: WriteResult = { ok: true, form_id: input.form_id, applied, new_revision };

  if (!input.dry_run) {
    await updateIdempotencyResult(input.idempotency_key, result);
  }

  return result;
}
