/**
 * RAG 返信案生成オーケストレーション (cs-manager サーバ側 adapter)
 *
 * PII boundary 厳守 (cs-manager-stage2-phase0-design.md §5):
 *  - 外部 (origin-ai) へ送るのは masked テキストのみ
 *  - raw PII は log に出さない
 *  - 顧客名等プレースホルダの復元は **外部呼び出し後にローカルでのみ** 行う
 *
 * フロー:
 *  (a) origin-ai /api/skills/rag-pii-mask で問い合わせ文をマスク → masked_query + 置換マップ
 *  (b) /api/skills/rag-hybrid-search (db_target='cs', pii_state='masked',
 *      filter_visibility=['public','internal'])
 *  (c) hit の article_id → cs DB から記事 title を解決 (citation 表示用)
 *  (d) /api/skills/rag-reply-draft (masked_query + masked_chunks + pii_state='masked')
 *  (e) 返ってきた draft 内のマスクトークンを **ローカルで** 復元
 *
 * 認証: origin-ai rag endpoint は `x-internal-api-key` を要求し、Core 解決した
 *       `origin_ai_internal.api_key` と定数時間比較する (案X)。よって本 adapter は
 *       Core 経由で `origin_ai_internal` の鍵を解決して送る (Vercel env 非依存 = B案)。
 *
 * ハードコード禁止: ORIGIN_AI_URL / 認証鍵 / model / filter_visibility は
 *   env or Core or 引数駆動。channel_id / store_id 直書きしない。
 */

import { getCredential } from '@/lib/credentials';
import type { SupabaseClient } from '@supabase/supabase-js';

// ---- 型 (origin-ai rag endpoint 契約に一致) ----------------------------

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
  contextual_prefix: string | null;
  rrf_score: number;
  vector_rank: number | null;
  tsvector_rank: number | null;
  trgm_rank: number | null;
}

interface ReplyChunk {
  chunk_id: string;
  article_id: string;
  article_version: number;
  content: string;
  title?: string | null;
}

export interface RagCitation {
  chunk_id: string;
  article_id: string;
  article_version: number;
  title: string | null;
  /** 検索時の RRF スコア (引用元の relevance 表示用、reply 側は持たないため search から補完) */
  rrf_score?: number | null;
}

interface ReplyDraftResponse {
  draft: string;
  citations: Array<{
    chunk_id: string;
    article_id: string;
    article_version: number;
    title?: string | null;
  }>;
  no_answer: boolean;
  needs_human: boolean;
  confidence: number;
  model: string;
}

export interface RagReplyInput {
  /** 件名 (raw、本 adapter 内でマスクされる) */
  subject: string | null;
  /** 問い合わせ本文 (raw、最新の inbound メッセージ等) */
  inquiryBody: string;
  /** 顧客名 (raw)。復元用 placeholder 化に使用 */
  customerName: string | null;
  /** チャネル絞り込み (任意、UUID)。未指定なら絞り込みなし */
  channelId?: string | null;
  /** テナント絞り込み (任意) */
  tenantId?: string | null;
}

export interface RagReplyResult {
  ok: boolean;
  /** マスク復元済みの返信ドラフト本文 (UI / 保存用) */
  draft?: string;
  citations?: RagCitation[];
  confidence?: number;
  noAnswer?: boolean;
  needsHuman?: boolean;
  model?: string | null;
  searchHitCount?: number;
  maskFailed?: boolean;
  durationMs?: number;
  error?: string;
}

// ---- 設定解決 (env 駆動、ハードコード禁止) -----------------------------

const RAG_INTERNAL_CRED_SERVICE_CODE =
  process.env.RAG_INTERNAL_CRED_SERVICE_CODE?.replace(/\s+$/, '') ||
  'origin_ai_internal';

/** filter_visibility 既定。env で上書き可 (カンマ区切り)。 */
function resolveFilterVisibility(): string[] {
  const raw = process.env.RAG_FILTER_VISIBILITY?.trim();
  if (raw) {
    const parts = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length > 0) return parts;
  }
  // cs-manager (顧客対応・社内オペレータが draft 確認) は public + internal を許可。
  // design §3.1: cs は require_acl=false 内部取得。
  return ['public', 'internal'];
}

function resolveOriginAiUrl(): string {
  const url = process.env.ORIGIN_AI_URL?.replace(/\s+$/, '');
  if (!url) throw new Error('ORIGIN_AI_URL is not set');
  return url.replace(/\/$/, '');
}

const RAG_TIMEOUT_MS = process.env.RAG_TIMEOUT_MS
  ? parseInt(process.env.RAG_TIMEOUT_MS, 10)
  : 60_000;

/** origin-ai rag endpoint 認証鍵 (Core 解決、env 非依存)。値は log/出力しない。 */
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
  const url = `${resolveOriginAiUrl()}${path}`;
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-API-Key': internalKey,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(RAG_TIMEOUT_MS),
    cache: 'no-store',
  });
}

// ---- マスク / 復元ヘルパ (復元は外部呼び出し後ローカルのみ) ---------------

/**
 * 顧客名を {{customer_name}} placeholder に置換する。
 * masked テキスト中に出現する customerName を全置換し、復元マップに登録。
 * (rag-pii-mask は氏名 NER 未対応のため、顧客名はここで明示的に placeholder 化する)
 */
function applyCustomerNamePlaceholder(
  text: string,
  customerName: string | null,
): { text: string; restoreToken?: { token: string; original: string } } {
  const name = customerName?.trim();
  if (!name) return { text };
  if (!text.includes(name)) return { text };
  const token = '{{customer_name}}';
  return {
    text: text.split(name).join(token),
    restoreToken: { token, original: name },
  };
}

/** masked テキストの全トークンをローカルで復元する。 */
function restoreLocally(
  text: string,
  replacements: Array<{ token: string; original: string }>,
): string {
  let out = text;
  for (const r of replacements) {
    if (!r.token) continue;
    out = out.split(r.token).join(r.original);
  }
  return out;
}

// ---- citation title 解決 (cs DB、外部送信しない) ------------------------

async function fetchArticleTitles(
  sb: SupabaseClient,
  articleIds: string[],
): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  const uniq = Array.from(new Set(articleIds)).filter(Boolean);
  if (uniq.length === 0) return map;
  const { data, error } = await sb
    .from('knowledge_articles')
    .select('id, title')
    .in('id', uniq);
  if (error) {
    // title 解決失敗は致命ではない (citation は chunk_id で表示可能) → 空 title で継続
    return map;
  }
  for (const row of data ?? []) {
    map.set((row as { id: string }).id, (row as { title: string | null }).title ?? null);
  }
  return map;
}

// ---- メイン: RAG 返信案生成 ---------------------------------------------

/**
 * RAG 返信案を生成する。PII boundary を厳守し、復元は外部呼び出し後ローカルのみ。
 * @param sb cs-manager service_role クライアント (title 解決に使用、外部送信しない)
 */
export async function generateRagReply(
  sb: SupabaseClient,
  input: RagReplyInput,
): Promise<RagReplyResult> {
  const startedAt = Date.now();

  let internalKey: string;
  try {
    internalKey = await resolveRagInternalKey();
  } catch (e) {
    return {
      ok: false,
      error: `RAG 認証鍵解決失敗: ${e instanceof Error ? e.message : String(e)}`,
      durationMs: Date.now() - startedAt,
    };
  }

  // (a) PII マスク: subject + 本文 をまとめてマスク
  const rawQueryParts = [input.subject?.trim(), input.inquiryBody?.trim()]
    .filter(Boolean)
    .join('\n\n');
  if (!rawQueryParts) {
    return { ok: false, error: '問い合わせ文が空です', durationMs: Date.now() - startedAt };
  }

  let maskRes: MaskResult;
  try {
    const res = await ragFetch('/api/skills/rag-pii-mask', internalKey, {
      texts: [rawQueryParts],
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return {
        ok: false,
        error: `rag-pii-mask ${res.status}: ${t.slice(0, 200)}`,
        durationMs: Date.now() - startedAt,
      };
    }
    const j = (await res.json()) as { results?: MaskResult[] };
    maskRes = j.results?.[0] ?? { masked_text: '', replacements: [], mask_failed: true };
  } catch (e) {
    return {
      ok: false,
      error: `rag-pii-mask 呼び出し失敗: ${e instanceof Error ? e.message : String(e)}`,
      durationMs: Date.now() - startedAt,
    };
  }

  // mask 失敗 → fail-closed: 外部 (search/reply) を呼ばない
  if (maskRes.mask_failed) {
    return {
      ok: false,
      maskFailed: true,
      error: 'PII マスクに失敗したため、安全のため返信案生成を中止しました',
      durationMs: Date.now() - startedAt,
    };
  }

  // 顧客名を placeholder 化 (regex マスクの後)
  const { text: maskedQuery, restoreToken: nameToken } = applyCustomerNamePlaceholder(
    maskRes.masked_text,
    input.customerName,
  );

  // 復元マップ (外部呼び出し後にローカル復元するためだけに保持。log に出さない)
  const restoreMap: Array<{ token: string; original: string }> = [
    ...maskRes.replacements.map((r) => ({ token: r.token, original: r.original })),
  ];
  if (nameToken) restoreMap.push(nameToken);

  // (b) hybrid search (masked query)
  let hits: SearchHit[] = [];
  try {
    const res = await ragFetch('/api/skills/rag-hybrid-search', internalKey, {
      db_target: 'cs',
      pii_state: 'masked',
      query_text: maskedQuery,
      filter_visibility: resolveFilterVisibility(),
      filter_channel_id: input.channelId ?? null,
      filter_tenant_id: input.tenantId ?? null,
      // cs は信頼内部ツール: require_acl=false で internal も取得 (design §3.1)
      require_acl: false,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return {
        ok: false,
        error: `rag-hybrid-search ${res.status}: ${t.slice(0, 200)}`,
        durationMs: Date.now() - startedAt,
      };
    }
    const j = (await res.json()) as { results?: SearchHit[] };
    hits = j.results ?? [];
  } catch (e) {
    return {
      ok: false,
      error: `rag-hybrid-search 呼び出し失敗: ${e instanceof Error ? e.message : String(e)}`,
      durationMs: Date.now() - startedAt,
    };
  }

  // (c) article title 解決 (citation 表示用、cs DB ローカル)
  const titleMap = await fetchArticleTitles(
    sb,
    hits.map((h) => h.article_id),
  );

  const maskedChunks: ReplyChunk[] = hits.map((h) => ({
    chunk_id: h.chunk_id,
    article_id: h.article_id,
    article_version: h.article_version,
    content: h.content,
    title: titleMap.get(h.article_id) ?? null,
  }));

  // (d) reply draft 生成 (masked query + masked chunks)
  let reply: ReplyDraftResponse;
  try {
    const res = await ragFetch('/api/skills/rag-reply-draft', internalKey, {
      masked_query: maskedQuery,
      masked_chunks: maskedChunks,
      pii_state: 'masked',
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return {
        ok: false,
        error: `rag-reply-draft ${res.status}: ${t.slice(0, 200)}`,
        searchHitCount: hits.length,
        durationMs: Date.now() - startedAt,
      };
    }
    reply = (await res.json()) as ReplyDraftResponse;
  } catch (e) {
    return {
      ok: false,
      error: `rag-reply-draft 呼び出し失敗: ${e instanceof Error ? e.message : String(e)}`,
      searchHitCount: hits.length,
      durationMs: Date.now() - startedAt,
    };
  }

  // (e) draft 内のマスクトークンをローカル復元 (外部送信後)
  const restoredDraft = restoreLocally(reply.draft ?? '', restoreMap);

  // citation の rrf_score を search hit から補完 (reply 側は score を返さない)
  const scoreByChunk = new Map(hits.map((h) => [h.chunk_id, h.rrf_score]));
  const citations: RagCitation[] = (reply.citations ?? []).map((c) => ({
    chunk_id: c.chunk_id,
    article_id: c.article_id,
    article_version: c.article_version,
    title: c.title ?? titleMap.get(c.article_id) ?? null,
    rrf_score: scoreByChunk.get(c.chunk_id) ?? null,
  }));

  return {
    ok: true,
    draft: restoredDraft,
    citations,
    confidence: reply.confidence,
    noAnswer: reply.no_answer,
    needsHuman: reply.needs_human,
    model: reply.model ?? null,
    searchHitCount: hits.length,
    maskFailed: false,
    durationMs: Date.now() - startedAt,
  };
}
