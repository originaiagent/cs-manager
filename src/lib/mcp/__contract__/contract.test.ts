/**
 * MCP contract test ハーネス — cs-manager (customer_record / memo)
 * 正本: minpaku-tool/src/mcp/__contract__/contract.test.ts。
 *
 * 検証項目:
 *   §1 manifest place_id → write_route のフィールド解決 (durable 検証)
 *   §2 list 応答が manifest と一致 (schema_version 含む)
 *   §3 dry_run write の validation 通過 / 不正値 rejected
 *   §4 楽観ロック (expected_revision 不一致 → rejected)
 *   §5 idempotency (reserve→replay / cross-run conflict / pending→processing / release→miss)
 *   §6 write_disabled ゲート (write_enabled=false → 拒否)
 *
 * これらに合格したフォームのみ ai_embed_form_gates.write_enabled = true にする。
 * テストは network/DB 不要 (service layer をモック)。
 */

import { describe, it, expect, vi } from 'vitest';
import { manifest, getForm, getPlace, SCHEMA_VERSION } from '@/lib/mcp/manifest';
import { handleList } from '@/lib/mcp/capabilities/list';
import { handleWrite } from '@/lib/mcp/capabilities/write';

// ---------------------------------------------------------------------------
// service.ts モック — DB/ネットワーク依存をなくす
// ---------------------------------------------------------------------------

vi.mock('@/lib/mcp/service', () => {
  const recordStore: Record<string, Record<string, unknown>> = {};
  const formGates: Record<string, boolean> = { customer_record: true };
  const idempotencyStore: Record<
    string,
    { idempotency_key: string; run_id: string; result_json: unknown; status: 'pending' | 'completed'; created_at: string }
  > = {};

  return {
    isFormWriteEnabled: vi.fn(async (form_id: string) => formGates[form_id] ?? false),

    checkIdempotencyKey: vi.fn(async (key: string, run_id: string) => {
      const record = idempotencyStore[key];
      if (!record) return { status: 'miss' };
      if (record.run_id !== run_id) return { status: 'conflict', run_id: record.run_id };
      if (record.status !== 'completed') return { status: 'processing' };
      return { status: 'hit', record };
    }),
    reserveIdempotencyKey: vi.fn(async (key: string, run_id: string) => {
      if (idempotencyStore[key]) return { status: 'conflict' };
      idempotencyStore[key] = { idempotency_key: key, run_id, result_json: {}, status: 'pending', created_at: new Date().toISOString() };
      return { status: 'reserved' };
    }),
    updateIdempotencyResult: vi.fn(async (key: string, result: unknown) => {
      if (idempotencyStore[key]) {
        idempotencyStore[key].result_json = result;
        idempotencyStore[key].status = 'completed';
      }
    }),
    releaseIdempotencyKey: vi.fn(async (key: string) => {
      if (idempotencyStore[key]?.status === 'pending') {
        delete idempotencyStore[key];
      }
    }),

    getCustomerRecord: vi.fn(async (id: string) => {
      const data = recordStore[id] ?? { id, memo: '初期メモ', updated_at: '2026-01-01T00:00:00.000Z' };
      return { ok: true, data };
    }),
    patchCustomerRecord: vi.fn(async (id: string, updates: Record<string, unknown>) => {
      const existing = recordStore[id] ?? { id, updated_at: '2026-01-01T00:00:00.000Z' };
      const updated = { ...existing, ...updates, updated_at: new Date().toISOString() };
      recordStore[id] = updated;
      return { ok: true, data: updated };
    }),
  };
});

// ---------------------------------------------------------------------------
// §1: manifest place_id → write_route durable 検証
// ---------------------------------------------------------------------------

describe('§1: manifest place_id durable 検証', () => {
  it('manifest に customer_record form が 1 つ定義されている', () => {
    expect(manifest.forms).toHaveLength(1);
    expect(manifest.forms.map((f) => f.form_id)).toContain('customer_record');
  });

  it('tool_slug は cs-manager', () => {
    expect(manifest.tool_slug).toBe('cs-manager');
  });

  it('customer_record の writable place は memo のみ (DB 列名に 1:1)', () => {
    const form = getForm('customer_record');
    expect(form).toBeDefined();
    const writablePlaces = form!.places.filter((p) => p.writable);
    expect(writablePlaces.map((p) => p.place_id)).toEqual(['memo']);
    expect(getPlace('customer_record', 'memo')?.type).toBe('text');
  });

  it('write_route が PATCH /api/customer-records/{target_id}', () => {
    const form = getForm('customer_record');
    expect(form!.write_route.method).toBe('PATCH');
    expect(form!.write_route.path_template).toBe('/api/customer-records/{target_id}');
  });

  it('write_route の path_template が target_id プレースホルダを含む', () => {
    const form = getForm('customer_record');
    expect(form!.write_route.path_template).toContain('{target_id}');
  });

  it('manifest signature が期待値と一致する (deterministic)', () => {
    const crypto = require('node:crypto');
    const body = JSON.stringify({ schema_version: SCHEMA_VERSION, forms: manifest.forms }, null, 0);
    const expected = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
    expect(manifest.signature).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// §2: list 応答 = manifest
// ---------------------------------------------------------------------------

describe('§2: list 応答 = manifest', () => {
  it('customer_record の list 応答が manifest と一致する', () => {
    const result = handleList({ form_id: 'customer_record' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.form_id).toBe('customer_record');
    expect(result.data.schema_version).toBe(SCHEMA_VERSION);
    expect(result.data.places).toEqual(getForm('customer_record')!.places);
  });

  it('不明な form_id は fail-closed で拒否される', () => {
    const result = handleList({ form_id: 'unknown' });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §3: dry_run write validation
// ---------------------------------------------------------------------------

describe('§3: dry_run write validation', () => {
  const TARGET_ID = 'rec-001';
  const RUN_ID = 'run-001';
  const baseInput = {
    form_id: 'customer_record',
    dry_run: true,
    idempotency_key: `idem-${Date.now()}`,
    provenance: { source: 'test', run_id: RUN_ID },
  };

  it('正常な set op (memo) は dry_run で ok:true を返す', async () => {
    const result = await handleWrite(
      { ...baseInput, ops: [{ kind: 'set', place_id: 'memo', value: '対応完了' }] },
      TARGET_ID,
      RUN_ID,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.new_revision).toBe('dry_run');
  });

  it('manifest に無い place_id は dry_run でも rejected', async () => {
    const result = await handleWrite(
      { ...baseInput, ops: [{ kind: 'set', place_id: 'nonexistent', value: 'x' }] },
      TARGET_ID,
      RUN_ID,
    );
    expect(result.ok).toBe(false);
  });

  it('memo に number を渡すと rejected (text 型必須)', async () => {
    const result = await handleWrite(
      { ...baseInput, ops: [{ kind: 'set', place_id: 'memo', value: 12345 }] },
      TARGET_ID,
      RUN_ID,
    );
    expect(result.ok).toBe(false);
  });

  it('maxLength (5000) 超過は rejected', async () => {
    const result = await handleWrite(
      { ...baseInput, ops: [{ kind: 'set', place_id: 'memo', value: 'a'.repeat(5001) }] },
      TARGET_ID,
      RUN_ID,
    );
    expect(result.ok).toBe(false);
  });

  it('null 値は許可 (memo クリア)', async () => {
    const result = await handleWrite(
      { ...baseInput, ops: [{ kind: 'set', place_id: 'memo', value: null }] },
      TARGET_ID,
      RUN_ID,
    );
    expect(result.ok).toBe(true);
  });

  it('set 以外の op (create-place) は rejected', async () => {
    const result = await handleWrite(
      { ...baseInput, ops: [{ kind: 'create-place', group_place_id: 'memo', value: {} } as never] },
      TARGET_ID,
      RUN_ID,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('未サポート');
  });
});

// ---------------------------------------------------------------------------
// §4: 楽観ロック
// ---------------------------------------------------------------------------

describe('§4: 楽観ロック', () => {
  const TARGET_ID = 'rec-lock-001';
  const RUN_ID = 'run-002';

  it('expected_revision が一致する場合は通過する (dry_run)', async () => {
    // getCustomerRecord モックは updated_at='2026-01-01T00:00:00.000Z' を返す
    const result = await handleWrite(
      {
        form_id: 'customer_record',
        ops: [{ kind: 'set', place_id: 'memo', value: 'ok' }],
        dry_run: true,
        idempotency_key: `idem-lock-ok-${Date.now()}`,
        expected_revision: '2026-01-01T00:00:00.000Z',
        provenance: { source: 'test', run_id: RUN_ID },
      },
      TARGET_ID,
      RUN_ID,
    );
    expect(result.ok).toBe(true);
  });

  it('expected_revision が一致しない場合は rejected', async () => {
    const result = await handleWrite(
      {
        form_id: 'customer_record',
        ops: [{ kind: 'set', place_id: 'memo', value: 'ng' }],
        dry_run: false,
        idempotency_key: `idem-lock-fail-${Date.now()}`,
        expected_revision: 'wrong-revision-etag',
        provenance: { source: 'test', run_id: RUN_ID },
      },
      TARGET_ID,
      RUN_ID,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('楽観ロック');
    expect(result.current_revision).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// §5: idempotency
// ---------------------------------------------------------------------------

describe('§5: idempotency INSERT-first 予約', () => {
  const TARGET_ID = 'rec-idem-001';

  it('live write は実際に memo を更新し new_revision を返す', async () => {
    const result = await handleWrite(
      {
        form_id: 'customer_record',
        ops: [{ kind: 'set', place_id: 'memo', value: 'ライブ更新' }],
        dry_run: false,
        idempotency_key: `idem-live-${Date.now()}`,
        provenance: { source: 'test', run_id: 'run-live-001' },
      },
      TARGET_ID,
      'run-live-001',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.applied).toHaveLength(1);
    expect(typeof result.new_revision).toBe('string');
    expect(result.new_revision).not.toBe('dry_run');
  });

  it('同一 run_id + 同一 key の 2 回目は 1 回目の結果をリプレイする', async () => {
    const key = `idem-replay-${Date.now()}`;
    const RUN = 'run-replay-001';
    const first = await handleWrite(
      {
        form_id: 'customer_record',
        ops: [{ kind: 'set', place_id: 'memo', value: '1回目' }],
        dry_run: false,
        idempotency_key: key,
        provenance: { source: 'test', run_id: RUN },
      },
      TARGET_ID,
      RUN,
    );
    expect(first.ok).toBe(true);

    const second = await handleWrite(
      {
        form_id: 'customer_record',
        ops: [{ kind: 'set', place_id: 'memo', value: '2回目(無視されるべき)' }],
        dry_run: false,
        idempotency_key: key,
        provenance: { source: 'test', run_id: RUN },
      },
      TARGET_ID,
      RUN,
    );
    expect(second).toEqual(first);
  });

  it('別 run_id が同じ key を所有している場合は conflict で拒否', async () => {
    const key = `idem-cross-${Date.now()}`;
    const first = await handleWrite(
      {
        form_id: 'customer_record',
        ops: [{ kind: 'set', place_id: 'memo', value: 'Run A' }],
        dry_run: false,
        idempotency_key: key,
        provenance: { source: 'test', run_id: 'run-A' },
      },
      TARGET_ID,
      'run-A',
    );
    expect(first.ok).toBe(true);

    const second = await handleWrite(
      {
        form_id: 'customer_record',
        ops: [{ kind: 'set', place_id: 'memo', value: 'Run B' }],
        dry_run: false,
        idempotency_key: key,
        provenance: { source: 'test', run_id: 'run-B' },
      },
      TARGET_ID,
      'run-B',
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toContain('別の run');
  });

  it('pending→processing, completed→hit, release→miss の lifecycle', async () => {
    const { reserveIdempotencyKey, updateIdempotencyResult, releaseIdempotencyKey, checkIdempotencyKey } =
      await import('@/lib/mcp/service');

    const key1 = `idem-pending-${Date.now()}`;
    const RUN1 = `run-pending-${Date.now()}`;
    await reserveIdempotencyKey(key1, RUN1);
    expect((await checkIdempotencyKey(key1, RUN1)).status).toBe('processing');

    await updateIdempotencyResult(key1, { ok: true });
    expect((await checkIdempotencyKey(key1, RUN1)).status).toBe('hit');

    const key2 = `idem-release-${Date.now()}`;
    const RUN2 = `run-release-${Date.now()}`;
    await reserveIdempotencyKey(key2, RUN2);
    await releaseIdempotencyKey(key2);
    expect((await checkIdempotencyKey(key2, RUN2)).status).toBe('miss');
  });
});

// ---------------------------------------------------------------------------
// §6: write_disabled ゲート
// ---------------------------------------------------------------------------

describe('§6: write_disabled ゲート', () => {
  it('write_enabled=false のフォームへの live write は拒否される', async () => {
    const { isFormWriteEnabled } = await import('@/lib/mcp/service');
    vi.mocked(isFormWriteEnabled).mockResolvedValueOnce(false);

    const result = await handleWrite(
      {
        form_id: 'customer_record',
        ops: [{ kind: 'set', place_id: 'memo', value: 'test' }],
        dry_run: false,
        idempotency_key: `idem-disabled-${Date.now()}`,
        provenance: { source: 'test', run_id: 'run-004' },
      },
      'rec-disabled',
      'run-004',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('write が無効');
  });

  it('dry_run は write_enabled=false でも通過する', async () => {
    const { isFormWriteEnabled } = await import('@/lib/mcp/service');
    vi.mocked(isFormWriteEnabled).mockResolvedValueOnce(false);

    const result = await handleWrite(
      {
        form_id: 'customer_record',
        ops: [{ kind: 'set', place_id: 'memo', value: 'test' }],
        dry_run: true,
        idempotency_key: `idem-dryrun-gate-${Date.now()}`,
        provenance: { source: 'test', run_id: 'run-005' },
      },
      'rec-dryrun',
      'run-005',
    );
    expect(result.ok).toBe(true);
  });
});
