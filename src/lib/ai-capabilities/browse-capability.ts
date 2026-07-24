/**
 * capability: browse — カタログ allowlist 内テーブルの汎用 read (list / rows)。
 *
 * 能力自動増殖ループ M2「汎用読み層 data_browse」の cs-manager 側 browse 窓。
 * 契約 (origin-ai docs/ops/capability-loop-impl-design.md §2.1・固定):
 *   - 操作は op='list' | op='rows' の 2 つのみ。WHERE 式・join・任意 SQL・RPC・書込は一切なし。
 *   - list: カタログ (browse-catalog.ts) をそのまま返す。
 *   - rows: table はカタログ完全一致のみ。limit 1..100 clamp (default 50) /
 *     offset 0..10000 clamp (default 0)。範囲外整数は clamp・型不正のみ 400。
 *     limit+1 件 fetch して truncated 判定。ソートはカタログ固定 (PK 最終タイブレーカー)。
 *   - 応答サイズ機械保証: 各セルは stringify 後 2000 字で決定論切詰 ('…[truncated]' 付与)。
 *     行を直列化しながら累積バイト数を計測し、総 payload が 1,000,000 バイトを超える手前で
 *     行単位に打ち切って truncated:true (JSON を途中切断しない)。
 *   - 成功 200 = BrowseListResponse / BrowseRowsResponse を素で返す。as_of (ISO8601) 必須。
 *   - エラー: 400 invalid_op / unknown_table / invalid_limit / invalid_offset,
 *     500 browse_failed。body は {error:'<code>'} のみ (下流の生エラー/スタック/env は返さない)。
 */

import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import { BROWSE_CATALOG, getBrowseCatalogEntry, type BrowseCatalogEntry } from '@/lib/ai-capabilities/browse-catalog';

export interface BrowseListResponse {
  operation: 'list';
  as_of: string;
  tables: Array<{
    table: string;
    description: string;
    columns: string[];
    order_by: string;
    note?: string;
  }>;
}

export interface BrowseRowsResponse {
  operation: 'rows';
  as_of: string;
  table: string;
  columns: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
}

const LIMIT_DEFAULT = 50;
const LIMIT_MIN = 1;
const LIMIT_MAX = 100;
const OFFSET_DEFAULT = 0;
const OFFSET_MIN = 0;
const OFFSET_MAX = 10000;
/** 各セルの stringify 後上限 (超過分は決定論切詰)。 */
const CELL_MAX_CHARS = 2000;
const CELL_TRUNCATION_SUFFIX = '…[truncated]';
/** 総 payload (UTF-8・最終 JSON 全体) の上限。超える手前で行単位に打ち切る。 */
const MAX_PAYLOAD_BYTES = 1_000_000;

/** 整数として型有効な文字列のみ許可 (小数・文字列混在は型不正 → 400)。 */
const INT_RE = /^-?\d+$/;

function browseErrorResponse(code: string, status: number): NextResponse {
  return NextResponse.json({ error: code }, { status });
}

/**
 * limit/offset の解釈。null (未指定) は default、型不正は null を返す (呼び元で 400)。
 * 範囲外の整数はエラーにせず clamp する (契約: invalid_* は型不正のみ)。
 */
function parseClampedInt(
  raw: string | null,
  def: number,
  min: number,
  max: number,
): number | null {
  if (raw === null) return def;
  if (!INT_RE.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(n)) return null;
  return Math.min(Math.max(n, min), max);
}

/** 各セルを stringify 後 2000 字で決定論切詰 (JSON を途中切断しない・文字列化して返す)。 */
function truncateCell(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > CELL_MAX_CHARS
      ? value.slice(0, CELL_MAX_CHARS) + CELL_TRUNCATION_SUFFIX
      : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  // jsonb / 配列等: stringify 長で判定し、超過時は文字列セルとして切詰める。
  const s = JSON.stringify(value);
  if (typeof s === 'string' && s.length > CELL_MAX_CHARS) {
    return s.slice(0, CELL_MAX_CHARS) + CELL_TRUNCATION_SUFFIX;
  }
  return value;
}

/** カタログ固定 order_by ("col dir, col dir") を supabase .order() に決定論適用する。 */
function applyCatalogOrder<T extends { order: (column: string, opts: { ascending: boolean }) => T }>(
  query: T,
  entry: BrowseCatalogEntry,
): T {
  let q = query;
  for (const part of entry.order_by.split(',')) {
    const [column, direction] = part.trim().split(/\s+/);
    q = q.order(column, { ascending: direction?.toLowerCase() !== 'desc' });
  }
  return q;
}

function readBrowseList(): NextResponse {
  const payload: BrowseListResponse = {
    operation: 'list',
    as_of: new Date().toISOString(),
    tables: BROWSE_CATALOG.map((e) => ({
      table: e.table,
      description: e.description,
      columns: e.columns,
      order_by: e.order_by,
      ...(e.note ? { note: e.note } : {}),
    })),
  };
  return NextResponse.json(payload, { status: 200 });
}

async function readBrowseRows(sp: URLSearchParams): Promise<NextResponse> {
  const tableParam = sp.get('table');
  const entry = tableParam ? getBrowseCatalogEntry(tableParam) : undefined;
  if (!entry) return browseErrorResponse('unknown_table', 400);

  const limit = parseClampedInt(sp.get('limit'), LIMIT_DEFAULT, LIMIT_MIN, LIMIT_MAX);
  if (limit === null) return browseErrorResponse('invalid_limit', 400);
  const offset = parseClampedInt(sp.get('offset'), OFFSET_DEFAULT, OFFSET_MIN, OFFSET_MAX);
  if (offset === null) return browseErrorResponse('invalid_offset', 400);

  const sb = await getSupabaseAdmin();
  // limit+1 件 fetch で truncated 判定 (range は両端 inclusive = limit+1 行)。
  let q = sb.from(entry.table).select(entry.columns.join(','));
  q = applyCatalogOrder(q, entry);
  const { data, error } = await q.range(offset, offset + limit);
  if (error) {
    console.error(`[browse] rows query failed (table=${entry.table}):`, error.message);
    return browseErrorResponse('browse_failed', 500);
  }

  const fetched = (data ?? []) as unknown as Record<string, unknown>[];
  let truncated = fetched.length > limit;
  const candidates = fetched.slice(0, limit).map((row) => {
    const projected: Record<string, unknown> = {};
    for (const col of entry.columns) projected[col] = truncateCell(row[col]);
    return projected;
  });

  const asOf = new Date().toISOString();
  // 総 payload バイト上限: envelope (rows 空) を基底に、行ごとの直列化バイト+区切り 1 byte を
  // 累積し、上限を超える手前で行単位に打ち切る (保守的計上・JSON を途中切断しない)。
  const baseBytes = Buffer.byteLength(
    JSON.stringify({
      operation: 'rows',
      as_of: asOf,
      table: entry.table,
      columns: entry.columns,
      rows: [],
      truncated: false,
    }),
    'utf8',
  );
  const rows: Record<string, unknown>[] = [];
  let accBytes = 0;
  for (const row of candidates) {
    const rowBytes = Buffer.byteLength(JSON.stringify(row), 'utf8') + 1;
    if (baseBytes + accBytes + rowBytes > MAX_PAYLOAD_BYTES) {
      truncated = true;
      break;
    }
    rows.push(row);
    accBytes += rowBytes;
  }

  const payload: BrowseRowsResponse = {
    operation: 'rows',
    as_of: asOf,
    table: entry.table,
    columns: entry.columns,
    rows,
    truncated,
  };
  return NextResponse.json(payload, { status: 200 });
}

/**
 * capability: browse の実データ read (route.ts の dispatch から呼ぶ)。
 * 認証 (X-Internal-API-Key) は route 側 authorizeAiManifestRequest 済みが前提。
 */
export async function readBrowseCapability(sp: URLSearchParams): Promise<NextResponse> {
  try {
    const op = sp.get('op');
    if (op === 'list') return readBrowseList();
    // return await: reject をこの try/catch で捕捉して browse_failed に正規化するため必須。
    if (op === 'rows') return await readBrowseRows(sp);
    return browseErrorResponse('invalid_op', 400);
  } catch (error) {
    // 下流の生エラー/スタック/env は返さない (ログのみ)。
    console.error('[browse] failed:', error instanceof Error ? error.message : error);
    return browseErrorResponse('browse_failed', 500);
  }
}
