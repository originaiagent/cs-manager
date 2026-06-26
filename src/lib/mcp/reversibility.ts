/**
 * 書き込み可逆性レイヤー — tool 側 handshake オーケストレーション (v4)
 *
 * 正本: minpaku-tool/src/mcp/reversibility.ts (codex 9R PASS + 本番 undo E2E green)。
 * cs-manager は customer_record / memo の単一 scalar のため、pure-scalar set 経路のみを移植する。
 *
 * flag EMBED_REVERSIBILITY_ENABLED=ON の write でのみ呼ばれる。
 * OFF の場合は route がこのモジュールを一切呼ばず、現行 legacy write をそのまま実行する。
 *
 * 通常 write (purpose != 'undo'):
 *   1. before スナップショット取得 (scalar set op のみ)
 *   2. payload_hash = payloadHash({place_id: newValue})
 *   3. before_revision / expected_revision = customer_service_records.updated_at
 *   4. POST /api/embed/mcp/intent  → {ok, write_id, idempotency_key, approval_status}
 *   5. POST /api/embed/mcp/validate (purpose:'run')
 *   6. handleWrite (origin 由来 idempotency_key + expected_revision で OCC apply)
 *   7. POST /api/embed/mcp/audit (best-effort + retry)
 *
 * undo (purpose == 'undo'):
 *   - /intent を呼ばない。claim の write_id/idempotency_key/payload_hash/expected_revision を使う。
 *   - POST /api/embed/mcp/validate (purpose:'undo')
 *   - handleWrite (claim 由来 idempotency_key + expected_revision で OCC apply)
 *   - /audit は任意 (origin undoExecutor が決定論確定するため必須でない)
 *
 * fail-closed 徹底:
 *   - intent.ok != true / validate.valid != true / origin 到達不能 → write 中止
 *   - 通常 write は caller 供給の write_id/idempotency_key/purpose を信用しない (intent 返値のみ)
 *   - undo は claim 由来の値のみ使う
 *   - audit のみ best-effort (失敗しても apply 済み write は維持。origin reconcile が拾う)
 */

import type { McpJwtClaims } from './auth';
import { payloadHash } from './canonical';
import { handleWrite, type WriteInput, type WriteOp, type WriteResult } from './capabilities/write';
import { getPlace } from './manifest';
import { getCustomerRecord } from './service';

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

/** route から渡される handshake 入力 */
export interface ReversibilityInput {
  claims: McpJwtClaims;
  form_id: string;
  target_id: string;
  ops: WriteOp[];
  dry_run: boolean;
  expected_revision?: string; // caller 供給。undo では claim を優先する
  provenance: { source: string; run_id: string; extracted_from?: string };
  confidence?: number;
}

/** handshake 失敗 (write は実行されない) */
export interface ReversibilityError {
  ok: false;
  status: number;
  reason: string;
}

export type ReversibilityResult = { ok: true; write: WriteResult } | ReversibilityError;

// ---------------------------------------------------------------------------
// origin endpoint 呼び出しヘルパ
// ---------------------------------------------------------------------------

function originBaseUrl(): string | null {
  return process.env.ORIGIN_AI_BASE_URL ?? null;
}

async function validateKey(): Promise<string | null> {
  // auth.ts と同一: embed 専用検証鍵 EMBED_MCP_VALIDATE_KEY 優先、無ければ Core
  // core_internal_shared (接続鍵 Core 集約 Done-1 で global INTERNAL_API_KEY 直読みは廃止)。
  const { getSharedInternalApiKey } = await import('@/lib/credentials');
  return getSharedInternalApiKey();
}

async function postOrigin(
  path: string,
  body: unknown,
  timeoutMs = 5000,
): Promise<{ ok: true; json: Record<string, unknown> } | { ok: false; reason: string }> {
  const base = originBaseUrl();
  if (!base) return { ok: false, reason: 'ORIGIN_AI_BASE_URL 未設定' };
  const key = await validateKey();
  // 鍵未解決は無認証で origin-ai を叩かず fail-closed (codex 必須#5)。
  if (!key) return { ok: false, reason: `${path} 検証鍵 未解決 (fail-closed)` };

  let resp: Response;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    resp = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-API-Key': key,
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    clearTimeout(timer);
  } catch (e) {
    return { ok: false, reason: `${path} 到達不能 (fail-closed): ${(e as Error).message}` };
  }

  if (!resp.ok) {
    return { ok: false, reason: `${path} 非200: HTTP ${resp.status}` };
  }

  let json: Record<string, unknown>;
  try {
    json = (await resp.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: `${path} レスポンス parse 失敗` };
  }
  return { ok: true, json };
}

// ---------------------------------------------------------------------------
// before snapshot / revision
// ---------------------------------------------------------------------------

/**
 * reversible 対象の scalar set op を抽出する(正本: minpaku reversibleSetOps)。
 * - kind==='set' のみ。
 * - manifest place type が scalar(text/number/boolean/date/enum/lookup)であること。
 *   repeating/file は除外(getPlace().type で厳密判定)。customer_record は memo(text)のみ。
 * - child item place ("memo.x" 等)は除外。
 * - **value が省略(own プロパティ無し or undefined)の op は除外**。
 *   canonicalize が undefined を "null" として hash 化する一方 apply では undefined field が落ち、
 *   hash/apply parity が崩れるため(claim {memo:null} vs 実 no-op を作れる)。
 */
const SCALAR_PLACE_TYPES = new Set(['text', 'number', 'boolean', 'date', 'enum', 'lookup']);

function reversibleSetOps(form_id: string, ops: WriteOp[]): Array<{ place_id: string; value: unknown }> {
  const out: Array<{ place_id: string; value: unknown }> = [];
  for (const op of ops) {
    if (op.kind !== 'set') continue;
    if (op.place_id.includes('.')) continue; // child item は set 未サポート
    if (!Object.prototype.hasOwnProperty.call(op, 'value') || (op as { value?: unknown }).value === undefined) {
      continue; // value 欠落は parity 崩れ → 除外(後段で op集合不一致として fail-closed)
    }
    const place = getPlace(form_id, op.place_id);
    if (!place) continue; // manifest 未定義
    if (!SCALAR_PLACE_TYPES.has(place.type)) continue; // repeating/file は可逆対象外
    out.push({ place_id: op.place_id, value: op.value });
  }
  return out;
}

/**
 * scalar set 用に row を **1回だけ** 読み、before_values と before_revision を
 * **同一スナップショット** から作る(正本: minpaku captureBaseline)。
 * (別 read 間に write が割り込むと before_values=A / revision=rev(B) の不整合 intent ができ、
 *  undo baseline が壊れるため。reversible は scalar set のみ=revision は updated_at で一貫。)
 */
async function captureBaseline(
  form_id: string,
  target_id: string,
  setOps: Array<{ place_id: string; value: unknown }>,
): Promise<{ ok: true; before: Record<string, unknown>; revision: string } | { ok: false; reason: string }> {
  if (form_id !== 'customer_record') {
    return { ok: false, reason: `form_id "${form_id}" は可逆 write 未サポート` };
  }
  const r = await getCustomerRecord(target_id);
  if (!r.ok) return { ok: false, reason: `baseline 読み取り失敗 (customer_record): ${r.error.message}` };
  const row = r.data as unknown as Record<string, unknown>;
  const revision = r.data.updated_at ?? '';
  const before: Record<string, unknown> = {};
  for (const { place_id } of setOps) before[place_id] = row[place_id] ?? null;
  return { ok: true, before, revision };
}

// ---------------------------------------------------------------------------
// audit (best-effort + retry)
// ---------------------------------------------------------------------------

async function sendAudit(body: Record<string, unknown>): Promise<void> {
  // best-effort: 最大2回試行。失敗しても write 成功は維持する (origin reconcile が拾う)。
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await postOrigin('/api/embed/mcp/audit', body);
    if (r.ok) return;
    console.warn(`[mcp/reversibility] audit 送信失敗 (attempt ${attempt + 1}/2):`, r.reason);
  }
}

// ---------------------------------------------------------------------------
// メイン handshake
// ---------------------------------------------------------------------------

export async function handleReversibleWrite(input: ReversibilityInput): Promise<ReversibilityResult> {
  const { claims, form_id, target_id, ops } = input;
  const purpose = claims.purpose === 'undo' ? 'undo' : 'run';

  const setOps = reversibleSetOps(form_id, ops);

  // hash/validate/apply の op 集合を一致させる(fail-closed)。
  // reversibleSetOps が scalar set のみ抽出する一方で applyWrite は input.ops 全体を適用するため、
  // 非 set / 非 scalar / value 欠落 op は「intent/validate は空 payload なのに実 apply される」
  // parity 崩れを起こす。flag ON では **全 op が scalar set** でない write を拒否する。
  if (setOps.length !== ops.length) {
    return {
      ok: false,
      status: 403,
      reason:
        'reversible write: scalar set 以外の op(非 set / 非 scalar / value 欠落)は未対応です (fail-closed)',
    };
  }
  if (setOps.length === 0) {
    return { ok: false, status: 403, reason: 'reversible write: 適用可能な scalar set op がありません' };
  }

  // place_ids: set ops の place_id (route 側で allowed_places は検証済み)
  const placeIds = setOps.map((o) => o.place_id);
  // 同一 place_id の重複 set を fail-closed 拒否。payloadObj は last-wins で潰れる一方、
  // handleWrite は ops を順次 apply するため hash/validate/apply parity が崩れる。
  if (new Set(placeIds).size !== placeIds.length) {
    return { ok: false, status: 403, reason: 'reversible write: 同一 place_id への重複 set は未対応 (fail-closed)' };
  }

  // payload_hash: 書込予定の {place_id: newValue}
  const payloadObj: Record<string, unknown> = {};
  for (const { place_id, value } of setOps) payloadObj[place_id] = value;
  const computedPayloadHash = payloadHash(payloadObj);

  // ====================================================================
  // undo パス: /intent を呼ばず claim 由来の値を使う
  // ====================================================================
  if (purpose === 'undo') {
    // undo は verified claim 由来のみ。caller fallback 禁止。
    // write_id / idempotency_key / payload_hash / expected_revision を全て claim 必須化。
    const writeId = claims.write_id;
    const idemKey = claims.idempotency_key;
    const claimPayloadHash = claims.payload_hash;
    const claimExpectedRevision = claims.expected_revision;

    if (!writeId || !idemKey) {
      return { ok: false, status: 403, reason: 'undo: claim に write_id / idempotency_key がありません (fail-closed)' };
    }
    if (!claimPayloadHash) {
      return { ok: false, status: 403, reason: 'undo: claim に payload_hash がありません (fail-closed)' };
    }
    if (!claimExpectedRevision) {
      return { ok: false, status: 403, reason: 'undo: claim に expected_revision がありません (OCC 必須・fail-closed)' };
    }
    // 実 apply する ops から再計算した hash が claim hash と一致することを tool 側で確認。
    // 不一致 = caller が claim 束縛と異なる payload を replay しようとした → fail-closed。
    if (computedPayloadHash !== claimPayloadHash) {
      return { ok: false, status: 403, reason: 'undo: 実 apply payload の hash が claim payload_hash と不一致 (fail-closed)' };
    }

    // validate (purpose:'undo') — claim 由来値のみ転送
    const validate = await postOrigin('/api/embed/mcp/validate', {
      jti: claims.jti,
      run_id: claims.run_id,
      op: 'write',
      place_id: placeIds[0] ?? null,
      place_ids: placeIds,
      target_type: claims.target_type,
      target_id,
      mcp_server_name: claims.mcp_server_name,
      form_id,
      write_id: writeId,
      idempotency_key: idemKey,
      payload_hash: claimPayloadHash,
      expected_revision: claimExpectedRevision,
      purpose: 'undo',
      session_id: claims.session_id ?? null,
      agent_id: claims.agent_id ?? null,
    });
    if (!validate.ok) return { ok: false, status: 403, reason: `undo validate: ${validate.reason}` };
    if (validate.json.valid !== true) {
      return { ok: false, status: 403, reason: `undo validate 拒否: ${String(validate.json.reason ?? 'unknown')}` };
    }

    // apply — claim 由来の idempotency_key + expected_revision で OCC
    const write = await applyWrite(input, idemKey, claimExpectedRevision);

    // audit は任意 (origin undoExecutor が決定論確定する)。送る場合は同形式。
    // after_values は書込んだ値(payloadObj)、after_revision は new_revision(別 read 無し)。
    if (!input.dry_run && write.ok) {
      await sendAudit({
        jti: claims.jti,
        write_id: writeId,
        state: 'applied',
        after_values: payloadObj,
        after_revision: write.new_revision,
      });
    }

    return { ok: true, write };
  }

  // ====================================================================
  // 通常 write パス: intent → validate → apply → audit
  // ====================================================================

  // source_request_id は verified claim のみ信用する (無ければ fail-closed)
  const sourceRequestId = claims.source_request_id;
  if (!sourceRequestId) {
    return { ok: false, status: 403, reason: '通常 write: claim に source_request_id がありません (fail-closed)' };
  }

  // before_values + before_revision を **同一スナップショット** から取得
  const baseline = await captureBaseline(form_id, target_id, setOps);
  if (!baseline.ok) return { ok: false, status: 409, reason: baseline.reason };
  const beforeRevision = baseline.revision;
  // caller が expected_revision を供給していれば、同一 row revision と一致する場合のみ採用(OCC 一貫)。
  // 不一致は stale → fail-closed(後段 handleWrite の OCC でも弾かれるが intent 前に止める)。
  if (input.expected_revision && input.expected_revision !== beforeRevision) {
    return { ok: false, status: 409, reason: '楽観ロック: caller expected_revision が現在 revision と不一致 (fail-closed)' };
  }
  const expectedRevision = beforeRevision;

  // intent
  const intent = await postOrigin('/api/embed/mcp/intent', {
    jti: claims.jti,
    source_request_id: sourceRequestId,
    target_id,
    place_ids: placeIds,
    payload_hash: computedPayloadHash,
    before_values: baseline.before,
    before_revision: beforeRevision,
    expected_revision: expectedRevision,
  });
  if (!intent.ok) return { ok: false, status: 403, reason: `intent: ${intent.reason}` };
  if (intent.json.ok !== true) {
    return { ok: false, status: 403, reason: `intent 拒否: ${String(intent.json.reason ?? 'ok!=true')}` };
  }
  // 通常 write は caller 供給を信用しない: intent 返値のみ使う
  const writeId = intent.json.write_id as string | undefined;
  const idemKey = intent.json.idempotency_key as string | undefined;
  if (!writeId || !idemKey) {
    return { ok: false, status: 403, reason: 'intent 返値に write_id / idempotency_key がありません (fail-closed)' };
  }

  // validate (purpose:'run')
  const validate = await postOrigin('/api/embed/mcp/validate', {
    jti: claims.jti,
    run_id: claims.run_id,
    op: 'write',
    place_id: placeIds[0] ?? null,
    place_ids: placeIds,
    target_type: claims.target_type,
    target_id,
    mcp_server_name: claims.mcp_server_name,
    form_id,
    write_id: writeId,
    idempotency_key: idemKey,
    payload_hash: computedPayloadHash,
    expected_revision: expectedRevision,
    purpose: 'run',
    session_id: claims.session_id ?? null,
    agent_id: claims.agent_id ?? null,
  });
  if (!validate.ok) return { ok: false, status: 403, reason: `validate: ${validate.reason}` };
  if (validate.json.valid !== true) {
    return { ok: false, status: 403, reason: `validate 拒否: ${String(validate.json.reason ?? 'unknown')}` };
  }

  // apply — origin 由来 idempotency_key + expected_revision で OCC
  const write = await applyWrite(input, idemKey, expectedRevision);

  // audit (best-effort + retry)。after_values は **書込んだ値そのもの**(payloadObj)を正とし、
  // after_revision は handleWrite が apply 直後に算出した new_revision を使う(別 read を挟まない)。
  if (!input.dry_run) {
    const state = write.ok ? 'applied' : 'failed';
    const afterValues = write.ok ? payloadObj : {};
    const afterRevision = write.ok ? write.new_revision : null;
    await sendAudit({
      jti: claims.jti,
      write_id: writeId,
      state,
      after_values: afterValues,
      after_revision: afterRevision,
    });
  }

  return { ok: true, write };
}

/** handleWrite を origin 由来 (または claim 由来) の idempotency_key / expected_revision で呼ぶ */
async function applyWrite(
  input: ReversibilityInput,
  idempotencyKey: string,
  expectedRevision: string | undefined,
): Promise<WriteResult> {
  const writeInput: WriteInput = {
    form_id: input.form_id,
    ops: input.ops,
    dry_run: input.dry_run,
    idempotency_key: idempotencyKey,
    expected_revision: expectedRevision,
    provenance: input.provenance,
    confidence: input.confidence,
  };
  return handleWrite(writeInput, input.target_id, input.claims.run_id);
}
