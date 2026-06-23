/**
 * RAG 返信案生成オーケストレーション (cs-manager サーバ側 adapter) — 方式A
 *
 * PII boundary 厳守 (cs-manager-stage2-phase0-design.md §5):
 *  - 外部 (origin-ai) へ送るのは masked テキストのみ
 *  - raw PII は log に出さない
 *  - 顧客名等プレースホルダの復元は **外部呼び出し後にローカルでのみ** 行う
 *
 * 方式A: ナレッジ検索は origin-ai の managed agent `customer-reply-writer` が
 *   cs-manager の MCP read tool `knowledge_search` を**自分で**呼んで行う。
 *   cs-manager 側は (a) ticket をマスク、(b) agent を masked context で起動、
 *   (c) 返ってきた draft の PII をローカル復元する。
 *
 * フロー:
 *  (a) origin-ai /api/skills/rag-pii-mask で件名+本文をマスク → masked_text + 置換マップ
 *      さらに顧客名・注文番号を placeholder 化 ({{customer_name}} / {{order_id}})
 *  (b) /api/agents/customer-reply-writer/chat (origin-ai v2 managed agent) に
 *      masked な構造化メッセージ ({message}) を渡す。agent が knowledge_search で
 *      自前検索し、masked な返信ドラフト本文 (`text`) を返す。
 *  (c) 返ってきた draft 内のマスクトークンを **ローカルで** 復元 → source='ai_draft' 保存。
 *
 * citation は方式A では cs 側から取得できない (検索は agent 内) → 空 citations を返す。
 *
 * 認証: origin-ai agent endpoint は `X-Internal-API-Key` を要求し、Core 解決した
 *       `origin_ai_internal.api_key` を送る (Vercel env 非依存 = B案)。
 *
 * ハードコード禁止: ORIGIN_AI_URL / 認証鍵 は env or Core 駆動。channel_id 直書きしない。
 */

import { getCredential } from '@/lib/credentials';
import { splitReply } from '@/lib/rag/split-reply';
import { searchKnowledgeArticleIds } from '@/lib/mcp/knowledge-search';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
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

export interface RagCitation {
  chunk_id: string;
  article_id: string;
  article_version: number;
  title: string | null;
  /** 検索時の RRF スコア (引用元の relevance 表示用)。方式A では非提供。 */
  rrf_score?: number | null;
}

/** customer-reply-writer agent chat レスポンス契約 (origin-ai v2) */
interface AgentChatResponse {
  agent?: string;
  /** 生成された返信ドラフト本文 (主フィールド) */
  text?: string;
  /** 防御的フォールバック (text 欠落時) */
  message?: string;
  draft?: string;
  model?: string | null;
}

export interface RagReplyInput {
  /** 件名 (raw、本 adapter 内でマスクされる) */
  subject: string | null;
  /** 問い合わせ本文 (raw、最新の inbound メッセージ等) */
  inquiryBody: string;
  /** 顧客名 (raw)。復元用 placeholder 化に使用 */
  customerName: string | null;
  /** 注文番号 (raw)。{{order_id}} placeholder 化に使用 (origin-ai へは raw 送信禁止) */
  orderNumber?: string | null;
  /** カテゴリー (任意、PII ではないため masked メッセージにラベル付きで含める) */
  category?: string | null;
  /** チャネル絞り込み (任意、UUID)。未指定なら絞り込みなし */
  channelId?: string | null;
  /** テナント絞り込み (任意) */
  tenantId?: string | null;
}

/**
 * 社内枠 (読み取り専用) に表示する「関連ナレッジ候補」1 件のメタ。
 *
 * **方式1 (server-side 再検索) の産物**: agent が実際に参照した記事と完全一致するとは限らない
 * (agent 出力に記事 ID が無いため、cs 側で masked query を再検索して候補を出す)。
 * → UI は「候補」「参照済みではない」旨を明示すること (「実使用記事」と誤認させない)。
 *
 * 値は cs DB `knowledge_articles` の **実メタ (非マスク)**。社内認証済み UI のみに表示し、
 * draft / 保存 / 送信 / log には絶対に流さない (顧客 PII ではなく社内 KB メタ)。
 */
export interface GroundingArticle {
  /** 記事 full UUID (/knowledge/<id> 詳細リンク用)。 */
  id: string;
  title: string | null;
  /** 想定問い合わせ。 */
  question: string | null;
  /** 対応方針。 */
  answer: string | null;
  /** ステータス (published 固定だが表示用に保持)。 */
  status: string | null;
}

export interface RagReplyResult {
  ok: boolean;
  /**
   * 顧客向け返信本文 (UI / 保存 / 送信用)。
   * **split-reply パーサで分離した顧客向け部分のみ**。社内テキスト (根拠/メモ) は
   * 含まない。parseOk=false 時は '' (fail-closed = 送信欄空)。生の agent 全文を
   * draft に入れることは絶対にない。
   */
  draft?: string;
  /**
   * 社内用プレビュー (読み取り専用表示用、根拠/メモ/narration 含む)。
   * parseOk=false 時は agent の raw 全文 (オペレータが手動切り出しできるよう)。
   */
  internalPreview?: string;
  /** split-reply の構造分離に成功したか。false = fail-closed (draft 空)。 */
  parseOk?: boolean;
  /**
   * 社内枠 (読み取り専用) 表示用「関連ナレッジ候補」。方式1 (masked query 再検索) で取得。
   * **表示専用**: draft / 保存 / 送信 path には絶対に入れない。search 失敗時は []。
   */
  groundingArticles?: GroundingArticle[];
  /** 社内枠「AI の参照メモ」(GROUNDING ブロックの marker 除去済み中身)。表示専用。 */
  internalGroundingText?: string;
  /** 社内枠「対応メモ」(NOTES ブロックの marker 除去済み中身)。表示専用。 */
  internalNotesText?: string;
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 文字列の全空白 (半角/全角含む) を除去した collapsed 形。 */
function collapseWhitespace(s: string): string {
  return s.replace(/[\s　]+/g, '');
}

/**
 * 既知 raw 値の「文字間に任意の空白を許す」正規表現を構築する (defense-in-depth, codex blocker)。
 * collapsed 形 (空白除去) の各文字の間に \s* を挟むことで、`山田太郎` から
 * `山田 太郎` / `山田　太郎` 等の表記揺れも捕捉する。rag-pii-mask が取り逃しても
 * 送信前にここで潰す。
 */
function buildLooseRegex(rawValue: string, suffixes: string[] = []): RegExp | null {
  const collapsed = collapseWhitespace(rawValue.trim());
  if (!collapsed) return null;
  const chars = Array.from(collapsed).map(escapeRegExp);
  // 文字間 \s* 許容 (全角空白含む)
  const core = chars.join('[\\s\\u3000]*');
  const suffixAlt =
    suffixes.length > 0
      ? `(?:[\\s\\u3000]*(?:${suffixes.map(escapeRegExp).join('|')}))?`
      : '';
  return new RegExp(core + suffixAlt, 'g');
}

/**
 * 顧客名を {{customer_name}} placeholder に置換する。
 * 文字間空白・敬称 (様/さん/殿/君/ちゃん) の表記揺れも捕捉する (loose regex)。
 * 返す `probe` は fail-closed assertion 用の collapsed 形 (空白除去後メッセージと照合)。
 */
function applyCustomerNamePlaceholder(
  text: string,
  customerName: string | null,
): { text: string; restoreToken?: { token: string; original: string }; probe: string | null } {
  const name = customerName?.trim();
  if (!name) return { text, probe: null };
  const re = buildLooseRegex(name, ['様', 'さん', '殿', '君', 'ちゃん']);
  if (!re) return { text, probe: null };
  const token = '{{customer_name}}';
  const replaced = text.replace(re, token);
  return {
    text: replaced,
    restoreToken: replaced.includes(token) ? { token, original: name } : undefined,
    probe: collapseWhitespace(name),
  };
}

/**
 * 注文番号を {{order_id}} placeholder に置換する。
 * 注文番号は PII 境界対象: raw で origin-ai へ送ってはならない (codex blocker)。
 * ハイフン・空白を跨いだ表記 (123-456 / 123 456) も捕捉する。
 * 復元トークンは常に返す (## 注文番号 欄に placeholder を載せるため)。
 * `probe` は fail-closed assertion 用の区切り除去 collapsed 形。
 */
function applyOrderNumberPlaceholder(
  text: string,
  orderNumber: string | null | undefined,
): {
  text: string;
  token: string | null;
  restoreToken?: { token: string; original: string };
  probe: string | null;
} {
  const order = orderNumber?.trim();
  if (!order) return { text, token: null, probe: null };
  // 区切り (空白/ハイフン) 除去した collapsed 形を基準に loose regex を作る。
  const collapsed = order.replace(/[\s　-]+/g, '');
  if (!collapsed) return { text, token: null, probe: null };
  const chars = Array.from(collapsed).map(escapeRegExp);
  const re = new RegExp(chars.join('[\\s\\u3000-]*'), 'g');
  const token = '{{order_id}}';
  const replaced = text.replace(re, token);
  return {
    text: replaced,
    token,
    restoreToken: { token, original: order },
    probe: collapsed,
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

// ---- メイン: RAG 返信案生成 ---------------------------------------------

/**
 * RAG 返信案を生成する。PII boundary を厳守し、復元は外部呼び出し後ローカルのみ。
 * @param _sb cs-manager service_role クライアント。方式A では検索が agent 側 (knowledge_search)
 *   に移ったため本関数内では未使用だが、呼出側シグネチャ互換のため受領する。
 */
export async function generateRagReply(
  _sb: SupabaseClient,
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
      // upstream error body は echo しない (raw query/PII 再露出防止 — codex blocker)
      return {
        ok: false,
        error: `rag-pii-mask ${res.status}`,
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

  // 顧客名を placeholder 化 (regex マスクの後、表記揺れ込み)
  const {
    text: nameMaskedQuery,
    restoreToken: nameToken,
    probe: nameProbe,
  } = applyCustomerNamePlaceholder(maskRes.masked_text, input.customerName);

  // 注文番号を placeholder 化 (raw で外部へ出さない — PII 境界)
  const {
    text: maskedQuery,
    token: orderToken,
    restoreToken: orderRestoreToken,
    probe: orderProbe,
  } = applyOrderNumberPlaceholder(nameMaskedQuery, input.orderNumber);

  // 復元マップ (外部呼び出し後にローカル復元するためだけに保持。log に出さない)
  const restoreMap: Array<{ token: string; original: string }> = [
    ...maskRes.replacements.map((r) => ({ token: r.token, original: r.original })),
  ];
  if (nameToken) restoreMap.push(nameToken);
  if (orderRestoreToken) restoreMap.push(orderRestoreToken);

  // (b) customer-reply-writer agent で返信ドラフト生成。
  //     方式A: ナレッジ検索は agent が knowledge_search MCP tool で自前実行する。
  //     cs 側は masked context ({message}) を渡すだけ (顧客名/注文番号は placeholder 化済み)。
  const agentMessage = buildAgentMessage({
    maskedQuery,
    category: input.category ?? null,
    orderToken,
  });

  // ── 送信直前 fail-closed assertion (codex blocker) ──────────────────────
  // 既知 raw 値 (顧客名/注文番号) の collapsed 形が agentMessage の collapsed 形に
  // 残っていないことを確認。残存時は raw PII 露出のため外部送信せず中止する
  // (rag-pii-mask + loose-regex 取りこぼしの最終防壁)。
  const collapsedMessage = collapseWhitespace(agentMessage.replace(/-/g, ''));
  const leaked = [nameProbe, orderProbe].some(
    (p) => p && collapsedMessage.includes(p),
  );
  if (leaked) {
    // 漏洩値そのものは log/返却しない (PII)。種別のみ記録。
    console.error(
      '[rag/reply-adapter] PII redaction leak detected (variant remained) — abort before agent call',
    );
    return {
      ok: false,
      maskFailed: true,
      error: 'PII マスク (顧客名/注文番号) が不完全なため、安全のため返信案生成を中止しました',
      durationMs: Date.now() - startedAt,
    };
  }

  let agentRes: AgentChatResponse;
  try {
    const res = await ragFetch(
      '/api/agents/customer-reply-writer/chat',
      internalKey,
      { message: agentMessage },
    );
    if (!res.ok) {
      // upstream error body は echo しない (送信した masked context の再露出防止)
      return {
        ok: false,
        error: `customer-reply-writer ${res.status}`,
        durationMs: Date.now() - startedAt,
      };
    }
    agentRes = (await res.json()) as AgentChatResponse;
  } catch (e) {
    return {
      ok: false,
      error: `customer-reply-writer 呼び出し失敗: ${e instanceof Error ? e.message : String(e)}`,
      durationMs: Date.now() - startedAt,
    };
  }

  // 契約: draft は `text`。欠落時のみ防御的に message/draft を試す。
  const rawDraft =
    (typeof agentRes.text === 'string' && agentRes.text.trim() && agentRes.text) ||
    (typeof agentRes.message === 'string' && agentRes.message) ||
    (typeof agentRes.draft === 'string' && agentRes.draft) ||
    '';

  if (!rawDraft.trim()) {
    return {
      ok: false,
      error: 'customer-reply-writer が空のドラフトを返しました',
      durationMs: Date.now() - startedAt,
    };
  }

  // (c) draft 内のマスクトークンをローカル復元 (外部送信後のみ)
  const restoredDraft = restoreLocally(rawDraft, restoreMap);

  // (d) 構造分離 (唯一の安全境界): agent 出力をセンチネルでパースし、
  //     顧客向け本文のみを draft とする。社内テキスト (根拠/メモ) は draft に入れない。
  //     parseOk=false → fail-closed (draft='' = 送信欄空)。raw 全文は internalPreview のみ。
  const split = splitReply(restoredDraft);

  // (e) 社内枠「関連ナレッジ候補」(方式1): parseOk 成功時のみ、保持済み maskedQuery で
  //     再検索 → article_id → cs DB から実メタ取得。**表示専用** で draft/保存/送信には
  //     一切流さない。検索失敗は握り潰して [] (生成全体は失敗させない — root cause は
  //     別経路の本文生成であり、候補表示の失敗で返信案を捨てない)。
  //     注: agent が実際に使った記事と完全一致しない「候補」(agent 出力に ID が無い)。
  let groundingArticles: GroundingArticle[] = [];
  if (split.parseOk) {
    try {
      groundingArticles = await fetchGroundingArticles(internalKey, maskedQuery);
    } catch (e) {
      // 候補取得失敗は致命ではない。種別のみ記録 (query/PII は出さない)。
      console.warn(
        '[rag/reply-adapter] grounding article 候補取得失敗 (表示なしで継続):',
        e instanceof Error ? e.message : String(e),
      );
      groundingArticles = [];
    }
  }

  // 方式A: citation は cs 側から取得できない (検索は agent 内 knowledge_search)。
  //   shape 互換のため空配列を返す。十分な根拠が無い場合は agent 自身が本文で
  //   その旨を述べる (self-report)。自動送信ゲートは別途、人間 click 必須を維持。
  return {
    ok: true,
    // draft は顧客向け本文のみ (parseOk=false なら '')。raw 全文は決して入らない。
    draft: split.customerReply,
    internalPreview: split.internalPreview,
    parseOk: split.parseOk,
    // ↓ 全て社内 read-only 表示専用。draft/保存/送信には絶対に入れない。
    groundingArticles,
    internalGroundingText: split.internalGroundingText,
    internalNotesText: split.internalNotesText,
    citations: [],
    confidence: undefined,
    noAnswer: false,
    needsHuman: false,
    model: agentRes.model ?? null,
    searchHitCount: 0,
    maskFailed: false,
    durationMs: Date.now() - startedAt,
  };
}

/** grounding 候補の最大表示件数 (社内枠が冗長にならないよう cap)。 */
const MAX_GROUNDING_ARTICLES = 5;

/**
 * 方式1: masked query で knowledge_search の検索コアを **直接関数呼び出し** し
 * (HTTP 自己呼出しない)、published かつ未削除の article_id を取得 → cs DB
 * `knowledge_articles` から実メタ (id/title/question/answer/status) を引く。
 *
 * - published かつ deleted_at IS NULL のみ (壊れたリンク防止)。
 * - id で重複除去し検索順を保ったまま最大 MAX_GROUNDING_ARTICLES 件。
 * - 実メタ (非マスク) を返すが **社内 read-only 表示専用** で外部送信しない。
 */
async function fetchGroundingArticles(
  internalKey: string,
  maskedQuery: string,
): Promise<GroundingArticle[]> {
  const ids = await searchKnowledgeArticleIds(
    maskedQuery,
    MAX_GROUNDING_ARTICLES,
    internalKey,
  );
  if (ids.length === 0) return [];

  const sb = await getSupabaseAdmin();
  const { data, error } = await sb
    .from('knowledge_articles')
    .select('id, title, question, answer, status')
    .in('id', ids)
    .eq('status', 'published')
    .is('deleted_at', null);
  if (error) {
    throw new Error(`knowledge_articles メタ取得失敗: ${error.message}`);
  }

  // id → 行のマップを作り、検索順 (ids の順) を保って並べる。
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of data ?? []) {
    byId.set((row as { id: string }).id, row as Record<string, unknown>);
  }
  const out: GroundingArticle[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) continue; // published/未削除でない (= 表示しない、壊れたリンク防止)
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

// ---- agent メッセージ構築 (全て masked) -------------------------------------

/**
 * customer-reply-writer agent へ渡す構造化メッセージを組み立てる。
 * 含めるのは全て masked な値のみ。注文番号は placeholder ({{order_id}})。
 * 方式A: ナレッジは含めない (agent が knowledge_search で自前検索する)。
 */
function buildAgentMessage(args: {
  maskedQuery: string;
  category: string | null;
  orderToken: string | null;
}): string {
  const { maskedQuery, category, orderToken } = args;
  return [
    '## 問い合わせ',
    maskedQuery,
    '',
    '## カテゴリー',
    category?.trim() || '不明',
    '',
    '## 注文番号',
    orderToken ?? '不明',
  ].join('\n');
}
