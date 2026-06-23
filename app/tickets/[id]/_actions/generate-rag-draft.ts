'use server';

import { internalFetch } from '@/lib/auth/internal-fetch';

export interface RagCitation {
  chunk_id: string;
  article_id: string;
  article_version: number;
  title: string | null;
  rrf_score?: number | null;
}

/**
 * 社内枠 (読み取り専用) に表示する関連ナレッジ候補 1 件のメタ。
 * 表示専用。draft/保存/送信には絶対に入れない。/knowledge/<id> リンクに full UUID を使う。
 */
export interface GroundingArticle {
  id: string;
  title: string | null;
  question: string | null;
  answer: string | null;
  status: string | null;
}

/** unknown を GroundingArticle[] へ防御的に正規化する (型を信頼しない)。 */
function normalizeGroundingArticles(v: unknown): GroundingArticle[] {
  if (!Array.isArray(v)) return [];
  const out: GroundingArticle[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (typeof o.id !== 'string' || !o.id) continue;
    out.push({
      id: o.id,
      title: typeof o.title === 'string' ? o.title : null,
      question: typeof o.question === 'string' ? o.question : null,
      answer: typeof o.answer === 'string' ? o.answer : null,
      status: typeof o.status === 'string' ? o.status : null,
    });
  }
  return out;
}

export interface GenerateRagDraftResult {
  ok: boolean;
  /** 顧客向け本文のみ (split-reply 分離後)。parseOk=false 時は ''。 */
  draft?: string;
  /** 社内用プレビュー (読み取り専用)。送信欄には入れない。 */
  internalPreview?: string;
  /** 構造分離に成功したか。false = fail-closed (送信欄空 / 採用不可)。 */
  parseOk?: boolean;
  /** 社内枠 (読み取り専用) 表示用「関連ナレッジ候補」。表示専用 (送信/保存しない)。 */
  groundingArticles?: GroundingArticle[];
  /** 社内枠「AI の参照メモ」(marker 除去済み)。表示専用。 */
  internalGroundingText?: string;
  /** 社内枠「対応メモ」(marker 除去済み)。表示専用。 */
  internalNotesText?: string;
  citations?: RagCitation[];
  confidence?: number | null;
  noAnswer?: boolean;
  needsHuman?: boolean;
  model?: string | null;
  searchHitCount?: number;
  withinBusinessHours?: boolean | null;
  /** 低 confidence 警告の閾値 (rag_config 駆動。UI ハードコード除去) */
  lowConfidenceThreshold?: number | null;
  durationMs?: number;
  error?: string;
}

/**
 * RAG 返信案生成 Server Action。
 *
 * /api/tickets/[id]/draft-rag は X-Internal-API-Key 必須化されているため、
 * ブラウザから直接 fetch せず、本 Server Action 経由で呼ぶ。
 * 鍵注入と base URL 解決は internalFetch に集約 (Host header 由来 SSRF 防止)。
 */
export async function generateRagDraft(
  ticketId: string,
): Promise<GenerateRagDraftResult> {
  try {
    const res = await internalFetch(
      `/api/tickets/${encodeURIComponent(ticketId)}/draft-rag`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || j.ok !== true) {
      return {
        ok: false,
        error:
          (typeof j.error === 'string' && j.error) ||
          `RAG generation failed: ${res.status}`,
        withinBusinessHours:
          typeof j.withinBusinessHours === 'boolean'
            ? j.withinBusinessHours
            : null,
      };
    }
    return {
      ok: true,
      draft: typeof j.draft === 'string' ? j.draft : '',
      internalPreview:
        typeof j.internalPreview === 'string' ? j.internalPreview : '',
      parseOk: j.parseOk === true,
      groundingArticles: normalizeGroundingArticles(j.groundingArticles),
      internalGroundingText:
        typeof j.internalGroundingText === 'string' ? j.internalGroundingText : '',
      internalNotesText:
        typeof j.internalNotesText === 'string' ? j.internalNotesText : '',
      citations: Array.isArray(j.citations) ? (j.citations as RagCitation[]) : [],
      confidence: typeof j.confidence === 'number' ? j.confidence : null,
      noAnswer: j.noAnswer === true,
      needsHuman: j.needsHuman === true,
      model: (j.model as string | null | undefined) ?? null,
      searchHitCount:
        typeof j.searchHitCount === 'number' ? j.searchHitCount : 0,
      withinBusinessHours:
        typeof j.withinBusinessHours === 'boolean'
          ? j.withinBusinessHours
          : null,
      lowConfidenceThreshold:
        typeof j.lowConfidenceThreshold === 'number'
          ? j.lowConfidenceThreshold
          : null,
      durationMs: typeof j.durationMs === 'number' ? j.durationMs : undefined,
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `network error: ${msg}` };
  }
}
