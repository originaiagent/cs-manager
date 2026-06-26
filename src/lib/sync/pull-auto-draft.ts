/**
 * pull 経路 (orchestrator) で新規 inbound message に対し RAG ドラフトを生成する薄い口。
 *
 * push 経路の `ingestInboundWithDraft` の draft 生成ハーフ (lines ~85-128) を pull 向けに
 * 切り出した関数。以下の設計原則を継承する:
 *
 *  - fail-closed: ドラフト生成失敗でも ticket/message は消さない (caller が既に永続化済み)。
 *    例外は一切外に投げない (catch → ingested_draft_failed/rag_exception)。
 *  - is_separated=true: AI 由来 (origin-ai embed) であることを保証。source='rag'。
 *  - PII 安全: ログ/エラーに raw body を出さない。失敗は固定 DraftErrorCode のみ。
 *  - 既存 draft チェックなし: 発火 gate は呼出側 (orchestrator) の atomic な inbound message
 *    insert (isNew) に一本化。本口は重複チェックを行わない (codex CONCERN#3)。
 *  - AI は origin-ai 経由のみ。prompt/LLM 直叩きなし。
 *
 * 楽天チャネルは従来通り first-response flow 経路を使う。本口は Yahoo (pull) 専用。
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  generateRagReply,
  type RagReplyResult,
} from '@/lib/rag/reply-adapter';
import type { DraftErrorCode, IngestInboundStatus } from '@/lib/sync/ingest-inbound';

export type { DraftErrorCode, IngestInboundStatus };

export interface PullAutoDraftArgs {
  /** cs-manager channels.id (ragInput.channelId に使用)。 */
  channelId: string;
  /** 既に永続化済みの ticket UUID (embed target_id として origin-ai へ渡す)。 */
  ticketId: string;
  /** 顧客問い合わせ本文 (raw)。マスクは origin-ai 側。ログに出さない。 */
  inboundBody: string;
  /** 顧客名 (raw、任意)。origin-ai 側で full-mask → 宛名復元。 */
  customerName?: string | null;
  /** 商品 ID (任意)。origin-ai 側 product_status_lookup 引数として使用 (best-effort)。 */
  productId?: string | null;
  /**
   * テスト注入用 generateReply。未指定なら origin-ai embed 経由の generateRagReply。
   * 型は ingestInboundWithDraft の generateReply と同一契約。
   */
  generateReply?: (sb: SupabaseClient, input: Parameters<typeof generateRagReply>[1]) => Promise<RagReplyResult>;
}

export interface PullAutoDraftResult {
  status: IngestInboundStatus;
  draftId?: string;
  draftError?: DraftErrorCode;
}

/**
 * pull 経路で新規 inbound に対し RAG ドラフトを生成し ticket_drafts へ保存する。
 *
 * 呼出側前提:
 *  - caller は既に ticket と inbound message を DB へ永続化済みである。
 *  - caller は `isNew===true` の場合のみ本口を呼ぶ (重複 inbound では呼ばない)。
 *  - 本口は draft 既存有無を確認しない。1 新規 inbound = 最大 1 draft の原則は caller が担保。
 *
 * 戻り値:
 *  - `ingested_with_draft` : draftId あり (ticket_drafts insert 成功)
 *  - `ingested_no_draft`   : RAG は動いたが draft なし (no_answer / parse 失敗)
 *  - `ingested_draft_failed`: RAG 失敗 / 例外 / DB 保存失敗 (ticket/message は無事)
 *
 * 例外: 絶対に throw しない。
 */
export async function generateDraftForNewInbound(
  sb: SupabaseClient,
  args: PullAutoDraftArgs,
): Promise<PullAutoDraftResult> {
  const generate = args.generateReply ?? generateRagReply;

  // ragInput: subject は pull 経路では null (ingest 層が別途 generateSubject() で解決する)。
  const ragInput = {
    subject: null as string | null,
    inquiryBody: args.inboundBody,
    customerName: args.customerName ?? null,
    channelId: args.channelId,
    tenantId: null as string | null,
    ticketId: args.ticketId,
    productId: args.productId ?? null,
  };

  let ragResult: RagReplyResult;
  try {
    ragResult = await generate(sb, ragInput);
  } catch (e) {
    // 例外メッセージは外部に出さない (PII 安全)。種別のみログ。
    console.error('[pull-auto-draft] rag_exception', {
      name: e instanceof Error ? e.name : 'unknown',
    });
    return { status: 'ingested_draft_failed', draftError: 'rag_exception' };
  }

  if (!ragResult.ok) {
    return { status: 'ingested_draft_failed', draftError: 'rag_upstream_error' };
  }

  // 構造分離 fail-closed (ingestInboundWithDraft と同一規律):
  //   parseOk が厳密に true の場合のみ保存。false / 未設定は混在の可能性があるため絶対に保存しない。
  if (ragResult.parseOk !== true) {
    return { status: 'ingested_no_draft', draftError: 'rag_parse_failed' };
  }
  if (!ragResult.draft || !ragResult.draft.trim()) {
    return { status: 'ingested_no_draft', draftError: 'rag_no_draft' };
  }

  // AI 由来 (origin-ai embed) のため source='rag' / is_separated=true で保存。
  const { data: draft, error: draftErr } = await sb
    .from('ticket_drafts')
    .insert({
      ticket_id: args.ticketId,
      body: ragResult.draft,
      source: 'rag',
      is_separated: true,
    })
    .select('id')
    .single();
  if (draftErr) {
    return { status: 'ingested_draft_failed', draftError: 'draft_persist_error' };
  }

  return { status: 'ingested_with_draft', draftId: draft.id as string };
}
