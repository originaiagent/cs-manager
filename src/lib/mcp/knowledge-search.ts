/**
 * MCP read tool `knowledge_search` — 方式A の中核 (origin-ai customer-reply-writer agent が
 * 自分で社内 CS ナレッジを意味検索するための読み取り専用ツール)。
 *
 * セキュリティ不変条件 (codex APPROVE / security-critical):
 *  - **専用静的キー認証**: env `CS_MCP_KNOWLEDGE_TOKEN` (trim) または Core credential
 *    `cs_mcp_knowledge.token` を `Authorization: Bearer <token>` で受け、定数時間比較する。
 *    `origin_ai_internal` / `INTERNAL_API_KEY` は **流用しない** (別の信頼境界)。
 *  - 静的キーは `knowledge_search` のみ認可。list/read/write には到達できない (route 側で分離)。
 *  - 逆に run-scoped JWT は `knowledge_search` に使えない (route 側で分離)。
 *  - サーバ固定パラメータ (db_target='cs' / pii_state='masked' /
 *    filter_visibility=['public','internal'] / status='published') は tool args から取らない。
 *  - 入力 query を rag-pii-mask で再マスク (defense-in-depth)。mask_failed → 検索を呼ばず error。
 *  - 返す title も rag-pii-mask でマスク (free-text のため defense-in-depth)。
 *  - limit ≤ 8 clamp、レスポンスサイズ上限、per-call timeout、簡易レート制限、監査ログ1行。
 *  - 生 PII / 生 token は一切 log/出力しない。
 *
 * 単一企業マルチストアの内部 KB のため channel/tenant のハード絞り込みはしない
 * (store scope は relevance のためのものであり、テナント境界=セキュリティ境界ではない)。
 */

import { timingSafeEqual, createHash } from 'node:crypto';
import { getCredential } from '@/lib/credentials';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';

// ---- 設定 (env / Core 駆動、ハードコード禁止) -------------------------------

/** 専用静的キーの Core credential service_code (env で上書き可)。 */
const KNOWLEDGE_TOKEN_CRED_SERVICE_CODE =
  process.env.CS_MCP_KNOWLEDGE_CRED_SERVICE_CODE?.replace(/\s+$/, '') ||
  'cs_mcp_knowledge';

/** origin-ai rag skill 認証鍵 (rag-pii-mask / rag-hybrid-search を呼ぶための内部鍵)。 */
const RAG_INTERNAL_CRED_SERVICE_CODE =
  process.env.RAG_INTERNAL_CRED_SERVICE_CODE?.replace(/\s+$/, '') ||
  'origin_ai_internal';

/** サーバ固定: 検索対象 DB。tool args からは取らない。 */
const FIXED_DB_TARGET = 'cs';
/** サーバ固定: PII 状態 (masked のみ)。 */
const FIXED_PII_STATE = 'masked';
/** サーバ固定: 可視性 (public + internal)。 */
const FIXED_FILTER_VISIBILITY = ['public', 'internal'] as const;
/** サーバ固定: published 記事のみ返す。 */
const FIXED_ARTICLE_STATUS = 'published';

/** limit の上限 (clamp)。 */
const MAX_LIMIT = 8;
const DEFAULT_LIMIT = 5;
/** 1 chunk あたりの content 切り詰め長 (レスポンスサイズ上限の一部)。 */
const MAX_CONTENT_CHARS = 1200;
/** レスポンス全体 (JSON 文字列) のおおよその上限。超過時は results を削る。 */
const MAX_RESPONSE_CHARS = 24_000;

const KNOWLEDGE_TIMEOUT_MS = process.env.CS_MCP_KNOWLEDGE_TIMEOUT_MS
  ? parseInt(process.env.CS_MCP_KNOWLEDGE_TIMEOUT_MS, 10)
  : 20_000;

/** 簡易レート制限: ウィンドウ内最大呼び出し回数 (プロセス内、ベストエフォート)。 */
const RATE_LIMIT_MAX = process.env.CS_MCP_KNOWLEDGE_RATE_MAX
  ? parseInt(process.env.CS_MCP_KNOWLEDGE_RATE_MAX, 10)
  : 30;
const RATE_LIMIT_WINDOW_MS = process.env.CS_MCP_KNOWLEDGE_RATE_WINDOW_MS
  ? parseInt(process.env.CS_MCP_KNOWLEDGE_RATE_WINDOW_MS, 10)
  : 60_000;

// ---- 型 (origin-ai rag skill 契約に一致) -----------------------------------

interface MaskReplacement {
  token: string;
  original: string;
  pii_type: string;
}
interface MaskResult {
  masked_text: string;
  replacements: MaskReplacement[];
  mask_failed: boolean;
}
interface SearchHit {
  chunk_id: string;
  article_id: string;
  article_version: number;
  content: string;
}

export interface KnowledgeSearchResultItem {
  title: string | null;
  content: string;
  article_id: string;
  chunk_id: string;
}

/**
 * published 記事のみに絞り込んだ検索ヒット (raw title 付き)。
 * MCP/agent path (handleKnowledgeSearch) はこれを基に title マスクを掛ける。
 * reply-adapter (社内枠表示) は article_id のみ取り出して使う。
 * - title は **生 (非マスク)**。MCP path 側でマスクする責務 (helper はマスクしない)。
 * - 全件 published かつ deleted_at IS NULL のみ (soft delete 除外)。
 */
export interface PublishedSearchHit {
  chunk_id: string;
  article_id: string;
  article_version: number;
  content: string;
  /** cs DB の生タイトル (null 可)。MCP path はこれをマスクして返す。 */
  rawTitle: string | null;
}

export type KnowledgeSearchOutcome =
  | { ok: true; payload: { results: KnowledgeSearchResultItem[]; count: number } }
  | { ok: false; error: string };

// ---- 認証 (専用静的キー、定数時間比較) -------------------------------------

/**
 * 定数時間比較 (codex Medium 対応)。両値を SHA-256 で固定長 digest 化してから
 * timingSafeEqual する。これにより入力長・長さ不一致による分岐/タイミング差を排除する。
 */
function constantTimeEqual(a: string, b: string): boolean {
  const aDigest = createHash('sha256').update(a, 'utf8').digest();
  const bDigest = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(aDigest, bDigest);
}

/** 期待トークン (env 優先、無ければ Core credential)。値は log しない。 */
async function resolveKnowledgeToken(): Promise<string | null> {
  const fromEnv = process.env.CS_MCP_KNOWLEDGE_TOKEN?.replace(/\s+$/, '');
  if (fromEnv) return fromEnv;
  try {
    const cred = await getCredential<{ token?: string }>(
      KNOWLEDGE_TOKEN_CRED_SERVICE_CODE,
    );
    const token = cred.credentials?.token?.replace(/\s+$/, '');
    return token || null;
  } catch {
    // Core 到達不能 / credential 不在 → トークン未解決 = fail-closed (呼出側で 401)。
    return null;
  }
}

/**
 * `Authorization: Bearer <token>` を専用静的キーと定数時間比較する。
 * 欠落/空/不一致は false (fail-closed)。トークンは log しない。
 * 戻り値 true 時は知識検索のみ認可される (他ツールには使えない)。
 */
export async function verifyKnowledgeToken(
  authHeader: string | null,
): Promise<boolean> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  const provided = authHeader.slice('Bearer '.length).trim();
  if (!provided) return false;
  const expected = await resolveKnowledgeToken();
  if (!expected) return false;
  return constantTimeEqual(provided, expected);
}

// ---- レート制限 (プロセス内ベストエフォート) -------------------------------

const rateWindow: number[] = [];
function checkRateLimit(): boolean {
  const now = Date.now();
  // ウィンドウ外を捨てる
  while (rateWindow.length > 0 && now - rateWindow[0] > RATE_LIMIT_WINDOW_MS) {
    rateWindow.shift();
  }
  if (rateWindow.length >= RATE_LIMIT_MAX) return false;
  rateWindow.push(now);
  return true;
}

// ---- origin-ai rag skill 呼び出し ------------------------------------------

function resolveOriginAiUrl(): string {
  const url = process.env.ORIGIN_AI_URL?.replace(/\s+$/, '');
  if (!url) throw new Error('ORIGIN_AI_URL is not set');
  return url.replace(/\/$/, '');
}

async function resolveRagInternalKey(): Promise<string> {
  const cred = await getCredential<{ api_key?: string }>(
    RAG_INTERNAL_CRED_SERVICE_CODE,
  );
  const key = cred.credentials?.api_key;
  if (!key) {
    throw new Error(
      `${RAG_INTERNAL_CRED_SERVICE_CODE} credential に api_key フィールドがありません (Core)`,
    );
  }
  return key.replace(/\s+$/, '');
}

async function ragFetch(
  path: string,
  internalKey: string,
  payload: unknown,
): Promise<Response> {
  return fetch(`${resolveOriginAiUrl()}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-API-Key': internalKey,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(KNOWLEDGE_TIMEOUT_MS),
    cache: 'no-store',
  });
}

/** texts を rag-pii-mask でマスクし、各 masked_text を返す。失敗時は throw。 */
async function maskTexts(
  internalKey: string,
  texts: string[],
): Promise<MaskResult[]> {
  const res = await ragFetch('/api/skills/rag-pii-mask', internalKey, { texts });
  if (!res.ok) {
    // upstream error body は echo しない (送信 texts に PII が含まれ得るため)
    throw new Error(`rag-pii-mask ${res.status}`);
  }
  const j = (await res.json()) as { results?: MaskResult[] };
  return j.results ?? [];
}

// ---- 監査ログ (生 PII / 生 token を出さない) -------------------------------

function shortHash(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 12);
}

function emitAudit(args: {
  traceId: string;
  authHeader: string | null;
  query: string;
  articleIds: string[];
  count: number;
}): void {
  // token は値そのものではなく「提示された Bearer のハッシュ末尾6」を記録 (相関用)。
  const provided =
    args.authHeader?.startsWith('Bearer ')
      ? args.authHeader.slice('Bearer '.length).trim()
      : '';
  const keyId = provided ? shortHash(provided).slice(-6) : 'none';
  console.info(
    '[mcp/knowledge_search] audit',
    JSON.stringify({
      trace_id: args.traceId,
      key_id: keyId,
      query_hash: shortHash(args.query),
      article_ids: Array.from(new Set(args.articleIds)),
      count: args.count,
    }),
  );
}

// ---- 共有検索コア (MCP path / reply-adapter 共用) ---------------------------

/**
 * masked query で rag-hybrid-search を実行し、published かつ未削除 (deleted_at IS NULL) の
 * 記事ヒットのみを raw title 付きで返す共有ヘルパ。
 *
 * **不変条件 (security-critical):**
 *  - サーバ固定パラメータ (db_target='cs' / pii_state='masked' /
 *    filter_visibility=['public','internal'] / status='published' / deleted_at IS NULL) は
 *    呼出側から変更できない (引数で受けない)。
 *  - title は **生 (非マスク)** で返す。マスクは呼出側 (MCP/agent path) の責務。
 *    reply-adapter は社内 read-only 表示用に生 title/メタを使う (外部送信しない)。
 *  - MCP 専用の token 検証 / レート制限はここに混ぜない (route / handler の責務)。
 *  - query は呼出側で再マスク済みである前提 (この helper は素の検索コアのみ)。
 *
 * @param maskedQuery  PII マスク済みクエリ (呼出側で rag-pii-mask 済み)。
 * @param limit        1..MAX_LIMIT に clamp 済みであること (呼出側責務)。
 * @param internalKey  origin-ai rag skill 認証鍵 (呼出側で Core 解決済み)。
 * @returns published かつ未削除のヒットのみ (raw title 付き)。
 * @throws rag-hybrid-search / knowledge_articles 参照に失敗した場合。
 */
export async function searchPublishedKnowledgeHits(
  maskedQuery: string,
  limit: number,
  internalKey: string,
): Promise<PublishedSearchHit[]> {
  // (1) hybrid search (サーバ固定パラメータ)。
  const res = await ragFetch('/api/skills/rag-hybrid-search', internalKey, {
    db_target: FIXED_DB_TARGET,
    pii_state: FIXED_PII_STATE,
    query_text: maskedQuery,
    filter_visibility: [...FIXED_FILTER_VISIBILITY],
    require_acl: false,
    limit,
  });
  if (!res.ok) {
    // upstream error body は echo しない (一貫した PII 非露出方針)
    throw new Error(`rag-hybrid-search ${res.status}`);
  }
  const j = (await res.json()) as { results?: SearchHit[] };
  const hits = (j.results ?? []).slice(0, limit);

  // (2) published かつ deleted_at IS NULL に絞り、title を解決 (cs DB ローカル)。
  //     soft delete (deleted_at) を除外しないと削除済み記事を拾う恐れがある。
  const articleIds = Array.from(new Set(hits.map((h) => h.article_id))).filter(Boolean);
  if (articleIds.length === 0) return [];

  const sb = await getSupabaseAdmin();
  const { data, error } = await sb
    .from('knowledge_articles')
    .select('id, title, status, deleted_at')
    .in('id', articleIds)
    .eq('status', FIXED_ARTICLE_STATUS)
    .is('deleted_at', null);
  if (error) {
    throw new Error(`knowledge_articles 参照失敗: ${error.message}`);
  }
  const publishedTitles = new Map<string, string | null>();
  for (const row of data ?? []) {
    publishedTitles.set(
      (row as { id: string }).id,
      (row as { title: string | null }).title ?? null,
    );
  }

  // published かつ未削除のヒットのみ、元の検索順を保って返す。
  return hits
    .filter((h) => publishedTitles.has(h.article_id))
    .map((h) => ({
      chunk_id: h.chunk_id,
      article_id: h.article_id,
      article_version: h.article_version,
      content: h.content ?? '',
      rawTitle: publishedTitles.get(h.article_id) ?? null,
    }));
}

/**
 * 社内枠表示 (reply-adapter / 方式1 再検索) 用: masked query で再検索し、
 * published かつ未削除の **full article_id (重複除去)** のみを検索順で返す。
 *
 * title/content は返さない (呼出側が cs DB から実メタを別途取得するため)。
 * `searchPublishedKnowledgeHits` の薄いラッパ。失敗は throw (呼出側で握り潰す方針)。
 *
 * @param maskedQuery PII マスク済みクエリ。
 * @param limit       検索 limit (呼出側で clamp 推奨)。
 * @param internalKey origin-ai rag 認証鍵 (Core 解決済み)。
 */
export async function searchKnowledgeArticleIds(
  maskedQuery: string,
  limit: number,
  internalKey: string,
): Promise<string[]> {
  const clamped = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
  const hits = await searchPublishedKnowledgeHits(maskedQuery, clamped, internalKey);
  // 検索順を保ったまま article_id を重複除去。
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const h of hits) {
    if (h.article_id && !seen.has(h.article_id)) {
      seen.add(h.article_id);
      ids.push(h.article_id);
    }
  }
  return ids;
}

// ---- ハンドラ (read-only) ---------------------------------------------------

/**
 * knowledge_search の本体。auth は呼出側 (route) が verifyKnowledgeToken で済ませている前提。
 * @param args     tool args ({query, limit?})。db_target 等は無視 (サーバ固定)。
 * @param traceId  監査相関 ID。
 * @param authHeader 監査ログの key_id 算出用 (値は記録しない)。
 */
export async function handleKnowledgeSearch(
  args: Record<string, unknown>,
  traceId: string,
  authHeader: string | null,
): Promise<KnowledgeSearchOutcome> {
  // レート制限 (ベストエフォート)
  if (!checkRateLimit()) {
    return { ok: false, error: 'レート制限に達しました。しばらくして再試行してください。' };
  }

  const rawQuery = typeof args.query === 'string' ? args.query.trim() : '';
  if (!rawQuery) {
    return { ok: false, error: 'query (自然言語、非空文字列) は必須です' };
  }

  // limit clamp (1..MAX_LIMIT)。tool args の db_target/pii_state/filter_visibility は無視。
  let limit = DEFAULT_LIMIT;
  if (typeof args.limit === 'number' && Number.isFinite(args.limit)) {
    limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(args.limit)));
  }

  let internalKey: string;
  try {
    internalKey = await resolveRagInternalKey();
  } catch (e) {
    return {
      ok: false,
      error: `RAG 認証鍵解決失敗: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // (1) 入力 query を再マスク (defense-in-depth)。mask_failed → 検索を呼ばない。
  let maskedQuery: string;
  try {
    const masked = await maskTexts(internalKey, [rawQuery]);
    const m = masked[0];
    if (!m || m.mask_failed) {
      return {
        ok: false,
        error: 'query の PII マスクに失敗したため検索を中止しました',
      };
    }
    maskedQuery = m.masked_text;
  } catch (e) {
    return {
      ok: false,
      error: `rag-pii-mask 呼び出し失敗: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // (2)(3) hybrid search (サーバ固定パラメータ) → published かつ未削除のヒットのみ。
  //     検索コア + published/deleted_at 絞り込みは共有ヘルパに集約 (reply-adapter と共用)。
  //     channel/tenant のハード絞り込みはしない (単一企業マルチストア KB; store scope は
  //     relevance のためのものでテナント境界ではない — 設計トレードオフ)。
  let publishedHits: PublishedSearchHit[];
  try {
    publishedHits = await searchPublishedKnowledgeHits(maskedQuery, limit, internalKey);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  // published hit の article_id → raw title マップ (マスク前)。
  const publishedTitles = new Map<string, string | null>();
  for (const h of publishedHits) publishedTitles.set(h.article_id, h.rawTitle);

  // (4) title を rag-pii-mask でマスク (free-text → defense-in-depth)。
  const rawTitles = Array.from(
    new Set(
      publishedHits
        .map((h) => h.rawTitle)
        .filter((t): t is string => typeof t === 'string' && t.trim().length > 0),
    ),
  );
  const maskedTitleMap = new Map<string, string>();
  if (rawTitles.length > 0) {
    try {
      const masked = await maskTexts(internalKey, rawTitles);
      rawTitles.forEach((orig, i) => {
        const m = masked[i];
        // title の mask_failed は致命ではない: 安全側で空タイトルにフォールバック。
        maskedTitleMap.set(orig, m && !m.mask_failed ? m.masked_text : '');
      });
    } catch {
      // title マスク呼び出し失敗 → 安全側で全タイトルを空にする (PII を漏らさない)。
      for (const orig of rawTitles) maskedTitleMap.set(orig, '');
    }
  }

  // (5) compact JSON 構築 (content 切り詰め + 全体サイズ上限)。
  let results: KnowledgeSearchResultItem[] = publishedHits.map((h) => {
    const rawTitle = publishedTitles.get(h.article_id);
    const title =
      typeof rawTitle === 'string' && rawTitle.trim().length > 0
        ? maskedTitleMap.get(rawTitle) ?? ''
        : null;
    return {
      title,
      content: (h.content ?? '').slice(0, MAX_CONTENT_CHARS),
      article_id: h.article_id,
      chunk_id: h.chunk_id,
    };
  });

  // 全体サイズ上限: 超過する間、末尾 result を削る。
  while (
    results.length > 0 &&
    JSON.stringify({ results, count: results.length }).length > MAX_RESPONSE_CHARS
  ) {
    results = results.slice(0, -1);
  }

  emitAudit({
    traceId,
    authHeader,
    query: maskedQuery,
    articleIds: results.map((r) => r.article_id),
    count: results.length,
  });

  return { ok: true, payload: { results, count: results.length } };
}
