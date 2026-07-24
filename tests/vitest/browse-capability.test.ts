/**
 * browse capability (汎用データ閲覧) のテスト。
 *
 * 検証 (契約: origin-ai docs/ops/capability-loop-impl-design.md §2.1):
 *  - op 不正/欠落は 400 invalid_op
 *  - list はカタログをそのまま返す (PII 列・除外テーブルが載っていないこと)
 *  - rows: カタログ外 table は 400 unknown_table / limit・offset は型不正のみ 400、
 *    範囲外整数は clamp / limit+1 fetch で truncated 判定 / 射影はカタログ列順
 *  - セル 2000 字切詰 ('…[truncated]') / 総 payload 1MB 手前の行単位打ち切り
 *  - DB エラーは 500 browse_failed (下流の生エラーを返さない)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rangeMock = vi.fn();
const orderMock = vi.fn();
const selectMock = vi.fn();
const fromMock = vi.fn();

function buildQueryMock() {
  const q: Record<string, unknown> = {};
  q.select = selectMock.mockReturnValue(q);
  q.order = orderMock.mockReturnValue(q);
  q.range = rangeMock;
  return q;
}

vi.mock('@/lib/db/supabase-admin', () => ({
  getSupabaseAdmin: async () => ({ from: fromMock }),
}));

import { readBrowseCapability } from '@/lib/ai-capabilities/browse-capability';
import { BROWSE_CATALOG, getBrowseCatalogEntry } from '@/lib/ai-capabilities/browse-catalog';

function sp(params: Record<string, string>) {
  return new URLSearchParams(params);
}

function ticketRow(i: number): Record<string, unknown> {
  const cols = getBrowseCatalogEntry('tickets')!.columns;
  const row: Record<string, unknown> = {};
  for (const col of cols) row[col] = `${col}-${i}`;
  return row;
}

beforeEach(() => {
  rangeMock.mockReset();
  orderMock.mockReset();
  selectMock.mockReset();
  fromMock.mockReset();
  fromMock.mockImplementation(() => buildQueryMock());
});

describe('browse: op validation', () => {
  it('op 欠落は 400 invalid_op', async () => {
    const res = await readBrowseCapability(sp({}));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_op' });
  });

  it('op 不正 (delete) は 400 invalid_op', async () => {
    const res = await readBrowseCapability(sp({ op: 'delete' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_op' });
  });
});

describe('browse: op=list', () => {
  it('カタログをそのまま返す (as_of 必須・DB は叩かない)', async () => {
    const res = await readBrowseCapability(sp({ op: 'list' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.operation).toBe('list');
    expect(typeof body.as_of).toBe('string');
    expect(Number.isNaN(Date.parse(body.as_of))).toBe(false);
    expect(body.tables).toHaveLength(BROWSE_CATALOG.length);
    expect(fromMock).not.toHaveBeenCalled();
    for (const t of body.tables) {
      expect(t.table).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(Array.isArray(t.columns)).toBe(true);
      expect(t.columns.length).toBeGreaterThan(0);
      // 固定ソートは必ず 2 キー以上 (最終タイブレーカー = PK) を持つ。
      expect(t.order_by.split(',').length).toBeGreaterThanOrEqual(2);
    }
  });

  it('PII 列・秘密列・除外テーブルがカタログに載っていない (fail-closed 検証)', async () => {
    const res = await readBrowseCapability(sp({ op: 'list' }));
    const body = await res.json();
    const tables = new Map<string, string[]>(
      body.tables.map((t: { table: string; columns: string[] }) => [t.table, t.columns]),
    );
    // 除外テーブル
    for (const excluded of [
      'messages',
      'pii_mask_tokens',
      'rag_chunks',
      'rag_chunk_embeddings',
      'rag_chunk_access_stats',
      'channel_inboxes',
      'channel_sync_state',
      'ai_embed_form_gates',
      'ai_embed_idempotency',
    ]) {
      expect(tables.has(excluded)).toBe(false);
    }
    // 除外列
    expect(tables.get('tickets')).not.toContain('customer_name');
    expect(tables.get('tickets')).not.toContain('customer_email');
    expect(tables.get('tickets')).not.toContain('channel_meta');
    expect(tables.get('customer_service_records')).not.toContain('recipient_name');
    expect(tables.get('customer_service_records')).not.toContain('recipient_honorific');
    expect(tables.get('customer_service_records')).not.toContain('line_account');
    expect(tables.get('customer_service_records')).not.toContain('memo');
    expect(tables.get('ticket_drafts')).not.toContain('body');
    expect(tables.get('knowledge_articles')).not.toContain('embedding');
    expect(tables.get('channels')).not.toContain('config');
    expect(tables.get('send_audit')).not.toContain('config_snapshot');
    expect(tables.get('send_audit')).not.toContain('masked_placeholders');
    // 公開すべき業務データ列
    expect(tables.get('tickets')).toContain('subject');
    expect(tables.get('customer_service_records')).toContain('order_number');
    expect(tables.get('knowledge_articles')).toContain('body_markdown');
  });
});

describe('browse: op=rows パラメータ検証', () => {
  it('カタログ外 table は 400 unknown_table (DB は叩かない)', async () => {
    const res = await readBrowseCapability(sp({ op: 'rows', table: 'pg_catalog.pg_tables' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'unknown_table' });
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('table 欠落も 400 unknown_table', async () => {
    const res = await readBrowseCapability(sp({ op: 'rows' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'unknown_table' });
  });

  it('limit 型不正 (abc / 1.5) は 400 invalid_limit', async () => {
    for (const bad of ['abc', '1.5']) {
      const res = await readBrowseCapability(sp({ op: 'rows', table: 'tickets', limit: bad }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_limit' });
    }
  });

  it('offset 型不正 (xyz) は 400 invalid_offset', async () => {
    const res = await readBrowseCapability(sp({ op: 'rows', table: 'tickets', offset: 'xyz' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_offset' });
  });

  it('範囲外整数は 400 にせず clamp する (limit 1000→100 / offset 99999→10000)', async () => {
    rangeMock.mockResolvedValue({ data: [], error: null });
    const res = await readBrowseCapability(
      sp({ op: 'rows', table: 'tickets', limit: '1000', offset: '99999' }),
    );
    expect(res.status).toBe(200);
    // range(offset, offset+limit) = (10000, 10100)
    expect(rangeMock).toHaveBeenCalledWith(10000, 10100);
  });

  it('limit/offset 未指定は default 50 / 0 (range(0, 50))', async () => {
    rangeMock.mockResolvedValue({ data: [], error: null });
    const res = await readBrowseCapability(sp({ op: 'rows', table: 'tickets' }));
    expect(res.status).toBe(200);
    expect(rangeMock).toHaveBeenCalledWith(0, 50);
  });
});

describe('browse: op=rows 取得と truncated 判定', () => {
  it('limit+1 件返却時は limit 件に切って truncated:true・射影はカタログ列順', async () => {
    const entry = getBrowseCatalogEntry('tickets')!;
    rangeMock.mockResolvedValue({
      data: Array.from({ length: 3 }, (_, i) => ({ ...ticketRow(i), customer_name: 'LEAK' })),
      error: null,
    });
    const res = await readBrowseCapability(sp({ op: 'rows', table: 'tickets', limit: '2' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.operation).toBe('rows');
    expect(body.table).toBe('tickets');
    expect(body.columns).toEqual(entry.columns);
    expect(body.rows).toHaveLength(2);
    expect(body.truncated).toBe(true);
    expect(typeof body.as_of).toBe('string');
    // 射影はカタログ列のみ (select 外の列が data に混ざっても漏らさない)。
    expect(Object.keys(body.rows[0])).toEqual(entry.columns);
    expect(JSON.stringify(body)).not.toContain('LEAK');
    // select はカタログ列の射影・order は固定ソート 2 キー。
    expect(selectMock).toHaveBeenCalledWith(entry.columns.join(','));
    expect(orderMock).toHaveBeenNthCalledWith(1, 'updated_at', { ascending: false });
    expect(orderMock).toHaveBeenNthCalledWith(2, 'id', { ascending: true });
  });

  it('limit 以内なら truncated:false', async () => {
    rangeMock.mockResolvedValue({ data: [ticketRow(1)], error: null });
    const res = await readBrowseCapability(sp({ op: 'rows', table: 'tickets', limit: '2' }));
    const body = await res.json();
    expect(body.rows).toHaveLength(1);
    expect(body.truncated).toBe(false);
  });

  it('セルは stringify 後 2000 字で切詰め (…[truncated] 付与・jsonb も対象)', async () => {
    const row = ticketRow(1);
    row.subject = 'x'.repeat(5000);
    row.external_id = { nested: 'y'.repeat(5000) }; // jsonb 相当
    rangeMock.mockResolvedValue({ data: [row], error: null });
    const res = await readBrowseCapability(sp({ op: 'rows', table: 'tickets' }));
    const body = await res.json();
    const subject = body.rows[0].subject as string;
    expect(subject.endsWith('…[truncated]')).toBe(true);
    expect(subject.length).toBe(2000 + '…[truncated]'.length);
    const externalId = body.rows[0].external_id as string;
    expect(typeof externalId).toBe('string');
    expect(externalId.endsWith('…[truncated]')).toBe(true);
  });

  it('総 payload 1MB 手前で行単位に打ち切り truncated:true (JSON は完全)', async () => {
    // 1 行 ≒ 14 列 × 2000 字 ≒ 28KB → 50 行で約 1.4MB > 1MB。
    const rows = Array.from({ length: 50 }, (_, i) => {
      const row = ticketRow(i);
      for (const col of Object.keys(row)) row[col] = 'z'.repeat(2000);
      return row;
    });
    rangeMock.mockResolvedValue({ data: rows, error: null });
    const res = await readBrowseCapability(sp({ op: 'rows', table: 'tickets', limit: '50' }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1_000_000);
    const body = JSON.parse(text); // 途中切断なし = parse 可能
    expect(body.truncated).toBe(true);
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.rows.length).toBeLessThan(50);
  });

  it('DB エラーは 500 browse_failed (生エラーメッセージを返さない)', async () => {
    rangeMock.mockResolvedValue({
      data: null,
      error: { message: 'secret internal detail' },
    });
    const res = await readBrowseCapability(sp({ op: 'rows', table: 'tickets' }));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'browse_failed' });
    expect(text).not.toContain('secret internal detail');
  });

  it('クエリ throw も 500 browse_failed に正規化', async () => {
    rangeMock.mockRejectedValue(new Error('boom env=SECRET'));
    const res = await readBrowseCapability(sp({ op: 'rows', table: 'tickets' }));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'browse_failed' });
    expect(text).not.toContain('boom');
  });
});

describe('browse: カタログ整合性', () => {
  it('全 entry が order_by の各キーを columns に含む (射影外ソート禁止)', () => {
    for (const entry of BROWSE_CATALOG) {
      for (const part of entry.order_by.split(',')) {
        const col = part.trim().split(/\s+/)[0];
        expect(entry.columns, `${entry.table}.order_by=${col}`).toContain(col);
      }
    }
  });

  it('table 名の重複なし・完全一致 lookup のみ', () => {
    const names = BROWSE_CATALOG.map((e) => e.table);
    expect(new Set(names).size).toBe(names.length);
    expect(getBrowseCatalogEntry('TICKETS')).toBeUndefined();
    expect(getBrowseCatalogEntry('tickets ')).toBeUndefined();
  });
});
