/**
 * RAG 返信案生成 (cs-manager サーバ側 adapter) — origin-ai embed 一本化版
 *
 * 設計レビュー: codex APPROVE (2026-06-24)。本 adapter は **業務 AI を一切持たない**:
 *   自前の LLM 呼出・検索クエリ生成・プロンプト直書き・PII マスク・出力パースを撤去し、
 *   origin-ai の embed 作業 `cs-reply:draft` (oneshot) を **1 本だけ** 起動して結果を写すだけにする。
 *   検索/マスク/生成/出典付与はすべて origin-ai 側 (設定駆動 retrieval→inject→gemma 生成) が行う。
 *
 * PII 境界:
 *   - cs-manager は raw な inquiry_text / customer_name を embed input として origin-ai へ送る。
 *     マスクは origin-ai 側 (送信直前 maskMany + assertExternalMasked、customer_name は full-mask、
 *     復元は入力由来のみ) が担保する。これは PR#603 の確定設計。
 *   - cs-manager 側ではログ/エラー/レスポンスに raw を出さない (embed helper は安定 reason のみ)。
 *
 * 送信安全境界 (codex CONCERN 反映 / fail-closed):
 *   - origin-ai が返す構造化 reply_draft を **そのまま顧客送信欄に流す前に** isCustomerSafeBody で
 *     最終検証する (内部マーカー/センチネル混入の二重防壁)。unsafe なら draft='' / parseOk=false とし、
 *     送信欄を空にする (inbound 直挿入経路も parseOk!==true で保存しない)。
 *   - 社内テキスト (sources / escalation_reason) は内枠 read-only 表示専用。draft/保存/送信 path に
 *     絶対に入れない。
 *
 * ハードコード禁止: 接続先/鍵は env (EMBED_CLIENT_KEY / ORIGIN_AI_BASE_URL) 駆動。
 */

// server-only 担保: 本モジュールは run-oneshot (window guard) と service_role client にのみ依存し、
//   draft-rag route (runtime='nodejs') / ingest-inbound からのみ import される。
import type { SupabaseClient } from '@supabase/supabase-js';
import { isCustomerSafeBody } from '@/lib/rag/split-reply';
import { runEmbedOneshotAndPoll } from '@/lib/embed/run-oneshot';

// origin-ai embed 作業の安定識別子 (bare slug) と target スコープ。
const WORK_SLUG = 'cs-reply:draft';
const TARGET_TYPE = 'customer_record';
/** 社内枠に出す関連ナレッジ候補の最大表示件数。 */
const MAX_GROUNDING_ARTICLES = 5;

// ---- 公開型 (消費者: draft-rag route / ingest-inbound / normalize / tests が依存。後方互換維持) ----

export interface RagCitation {
  chunk_id: string;
  article_id: string;
  article_version: number;
  title: string | null;
  /** origin-ai 取得 hit の RRF スコア (引用元 relevance 表示用)。 */
  rrf_score?: number | null;
}

/**
 * 社内枠 (読み取り専用) に表示する「関連ナレッジ候補」1 件のメタ。
 * 値は cs DB `knowledge_articles` の実メタ (非マスク・社内 KB)。社内認証済み UI のみに表示し、
 * draft / 保存 / 送信 / log には絶対に流さない。
 */
export interface GroundingArticle {
  id: string;
  title: string | null;
  question: string | null;
  answer: string | null;
  status: string | null;
}

export interface RagReplyInput {
  /** 件名 (raw)。inquiry_text に連結して送る。 */
  subject: string | null;
  /** 問い合わせ本文 (raw、最新 inbound メッセージ等)。 */
  inquiryBody: string;
  /** 顧客名 (raw)。origin-ai 側で full-mask → 宛名復元される。 */
  customerName: string | null;
  /** 注文番号 (任意)。新 skill 契約では未消費 (送らない)。型互換のため受領のみ。 */
  orderNumber?: string | null;
  /** カテゴリー (任意)。新 skill 契約では未消費。型互換のため受領のみ。 */
  category?: string | null;
  /** チャネル絞り込み (任意、未使用)。 */
  channelId?: string | null;
  /** テナント絞り込み (任意、未使用)。 */
  tenantId?: string | null;
  /** embed の target_id (= 対象 ticket UUID)。サーバ側で実在保証した値。未指定は fail。 */
  ticketId?: string | null;
  /** 商品 id (任意)。origin-ai 側 product_status_lookup の引数として使われる (best-effort)。 */
  productId?: string | null;
}

export interface RagReplyResult {
  ok: boolean;
  /**
   * 顧客向け返信本文 (UI 送信欄 / 保存用)。送信安全ゲート通過時のみ非空。
   * unsafe (内部マーカー混入/空) 時は '' (fail-closed)。
   */
  draft?: string;
  /** 社内用プレビュー (読み取り専用)。reply_draft 全文 (内枠参照表示用、送信 path 非流入)。 */
  internalPreview?: string;
  /** 送信安全ゲート通過 (顧客向け本文として安全) か。false = fail-closed (送信欄空)。 */
  parseOk?: boolean;
  /** 社内枠 (読み取り専用)「関連ナレッジ候補」(origin-ai sources の article_id → cs DB 実メタ)。表示専用。 */
  groundingArticles?: GroundingArticle[];
  /** 社内枠「AI の参照メモ」。embed 一本化では未提供 (常に '')。 */
  internalGroundingText?: string;
  /** 社内枠「対応メモ」。エスカレーション理由を載せる (表示専用)。 */
  internalNotesText?: string;
  citations?: RagCitation[];
  confidence?: number;
  noAnswer?: boolean;
  needsHuman?: boolean;
  model?: string | null;
  searchHitCount?: number;
  maskFailed?: boolean;
  durationMs?: number;
  /** 失敗時の PII-safe 安定ラベル (raw を含めない)。 */
  error?: string;
}

// ---- メイン: RAG 返信案生成 (embed 一本化) -------------------------------------

/**
 * RAG 返信案を生成する。origin-ai embed 作業 `cs-reply:draft` を 1 本起動し、結果を
 * 顧客/社内に分離して写すだけ (cs 側に AI 処理を持たない)。
 *
 * @param sb cs-manager service_role クライアント (grounding 表示メタ取得にのみ使用)。
 */
export async function generateRagReply(
  sb: SupabaseClient,
  input: RagReplyInput,
): Promise<RagReplyResult> {
  const startedAt = Date.now();

  const ticketId = input.ticketId?.trim();
  if (!ticketId) {
    return { ok: false, error: 'no_target_ticket', durationMs: Date.now() - startedAt };
  }

  // inquiry_text = 件名 + 本文 (raw)。マスクは origin-ai 側。
  const inquiryText = [input.subject?.trim(), input.inquiryBody?.trim()]
    .filter(Boolean)
    .join('\n\n');
  if (!inquiryText) {
    return { ok: false, error: 'empty_inquiry', durationMs: Date.now() - startedAt };
  }

  // embed input: skill skill-mqort4oa の input_text_keys=[inquiry_text, customer_name] +
  //   product_status_lookup args_from {product_id}。それ以外 (order_number 等) は送らない。
  const embedInput: Record<string, unknown> = { inquiry_text: inquiryText };
  if (input.customerName?.trim()) embedInput.customer_name = input.customerName.trim();
  if (input.productId?.trim()) embedInput.product_id = input.productId.trim();

  // ── 唯一の AI 起動: origin-ai embed (cs-reply:draft) ────────────────────────
  const run = await runEmbedOneshotAndPoll({
    slug: WORK_SLUG,
    targetType: TARGET_TYPE,
    targetId: ticketId,
    input: embedInput,
  });
  if (!run.ok || !run.result) {
    return {
      ok: false,
      error: run.reason ?? 'embed_run_failed',
      durationMs: Date.now() - startedAt,
    };
  }

  // ── 結果写像 (顧客/社内分離) ────────────────────────────────────────────────
  const r = run.result;
  const replyDraft = typeof r.reply_draft === 'string' ? r.reply_draft : '';
  const needsEscalation = r.needs_escalation === true;
  const escalationReason = typeof r.escalation_reason === 'string' ? r.escalation_reason : '';
  const sources = Array.isArray(r.sources) ? (r.sources as Record<string, unknown>[]) : [];

  // 送信安全ゲート (codex CONCERN): 構造化 reply_draft の最終バリデーション。
  // fail-closed: unsafe → draft='' / parseOk=false / internalPreview=reply_draft (手動切出用)。
  const safe = replyDraft.trim().length > 0 && isCustomerSafeBody(replyDraft);

  // sources → 表示用 citations (knowledge source = article_id を持つもののみ。lookup source は除外)。
  const citations: RagCitation[] = sources
    .filter((s) => typeof s.article_id === 'string' && s.article_id)
    .map((s) => ({
      chunk_id: typeof s.chunk_id === 'string' ? s.chunk_id : '',
      article_id: String(s.article_id),
      article_version: typeof s.article_version === 'number' ? s.article_version : 0,
      title: null,
      rrf_score: typeof s.score === 'number' ? s.score : null,
    }));

  // 社内枠「関連ナレッジ候補」: knowledge source の article_id を cs DB 実メタへ解決 (表示専用・非AI)。
  //   失敗は致命でない (候補表示の失敗で返信案を捨てない)。raw/PII は出さず種別のみ記録。
  let groundingArticles: GroundingArticle[] = [];
  try {
    groundingArticles = await fetchGroundingMeta(
      sb,
      citations.map((c) => c.article_id),
    );
  } catch (e) {
    console.warn('[rag/reply-adapter] grounding メタ取得失敗 (表示なしで継続):', {
      name: e instanceof Error ? e.name : 'unknown',
    });
    groundingArticles = [];
  }

  return {
    ok: true,
    // 顧客向け本文のみ (parseOk=false なら '')。raw 全文/社内テキストは draft に入らない。
    draft: safe ? replyDraft : '',
    parseOk: safe,
    // 内枠参照表示用 (送信 path 非流入)。unsafe 時もオペレータが手動切り出しできるよう全文。
    internalPreview: replyDraft,
    // ↓ 全て社内 read-only 表示専用。draft/保存/送信には絶対に入れない。
    groundingArticles,
    internalGroundingText: '',
    internalNotesText: needsEscalation ? escalationReason : '',
    citations,
    confidence: undefined,
    noAnswer: false,
    needsHuman: needsEscalation,
    model: null,
    searchHitCount: sources.length,
    maskFailed: false,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * origin-ai sources の article_id を cs DB `knowledge_articles` の実メタへ解決する。
 * - published かつ deleted_at IS NULL のみ (壊れたリンク防止)。
 * - id 重複除去・検索順保持・最大 MAX_GROUNDING_ARTICLES 件。
 * - **表示専用 (非AI・送信 path 非流入)**。question/answer 等を draft/保存本文に混ぜない。
 */
async function fetchGroundingMeta(
  sb: SupabaseClient,
  articleIds: string[],
): Promise<GroundingArticle[]> {
  // 重複除去・順序保持。
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of articleIds) {
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  if (ids.length === 0) return [];

  const { data, error } = await sb
    .from('knowledge_articles')
    .select('id, title, question, answer, status')
    .in('id', ids)
    .eq('status', 'published')
    .is('deleted_at', null);
  if (error) {
    throw new Error(`knowledge_articles メタ取得失敗: ${error.message}`);
  }

  const byId = new Map<string, Record<string, unknown>>();
  for (const row of data ?? []) {
    byId.set((row as { id: string }).id, row as Record<string, unknown>);
  }
  const out: GroundingArticle[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) continue; // published/未削除でない → 表示しない (壊れたリンク防止)
    out.push({
      id: String(row.id),
      title: (row.title as string | null) ?? null,
      question: (row.question as string | null) ?? null,
      answer: (row.answer as string | null) ?? null,
      status: (row.status as string | null) ?? null,
    });
    if (out.length >= MAX_GROUNDING_ARTICLES) break;
  }
  return out;
}
