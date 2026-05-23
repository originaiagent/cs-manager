'use server';

import { internalFetch } from '@/lib/auth/internal-fetch';

export interface RagCitation {
  chunk_id: string;
  article_id: string;
  article_version: number;
  title: string | null;
  rrf_score?: number | null;
}

export interface GenerateRagDraftResult {
  ok: boolean;
  draft?: string;
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
