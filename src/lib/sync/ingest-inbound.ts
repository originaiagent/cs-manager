/**
 * チャネル非依存の inbound 取込 + 返信ドラフト生成 (push 経路共通)
 *
 * メール inbound webhook と LINE webhook (および将来の push チャネル) が共用する。
 * 「ticket+message を冪等 upsert → 新規なら origin-ai RAG でドラフト生成 → ticket_drafts 保存」
 * のロジックをここに一本化する (DRY / 共通 ingest)。
 *
 * 設計レビュー: codex APPROVE (2026-06-12, round2)。CONCERN#5 反映として、抽出前に
 * email の外部契約 (status 集合 / PII-safe error code / duplicate / channel_meta) を
 * テストで pin した上で本関数へ移管している。
 *
 * 不変条件 (email-ingest から継承):
 *  - 冪等: message は (ticket_id, channel_message_id) UNIQUE。再送 (isNew=false) は draft を作らない。
 *  - PII 安全: 外部/DB へ出すエラーは固定コード (DraftErrorCode) のみ。生テキストを載せない。
 *  - 送信なし: draft は source 既定 'rag' / status 既定 'pending'。auto-approve しない。
 *  - 受信ロスト防止: RAG 失敗でも ticket / message は残す。
 *
 * channel_meta への失敗記録は呼び出し側の責務 (チャネルごとに meta キーが異なるため)。
 * 本関数は status と draftError を返すだけで channel_meta を書かない。
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { NormalizedTicket, NormalizedMessage } from '@/channels/_lib/types';
import { upsertTicket, upsertMessageReturningNew } from '@/lib/sync/ingest';
import { generateRagReply, type RagReplyInput, type RagReplyResult } from '@/lib/rag/reply-adapter';

/**
 * ドラフト生成失敗の安定コード (PII を含まない)。
 * email-ingest の DraftErrorCode と同一集合。外部に出すのはこのコードのみ。
 */
export type DraftErrorCode =
  | 'rag_upstream_error' // RAG エンドポイントが非 OK / draft 不正
  | 'rag_no_draft' // RAG は成功したが draft 空 (no_answer 等)
  | 'rag_parse_failed' // RAG は成功したが構造分離に失敗 (混在のため保存しない、fail-closed)
  | 'rag_exception' // RAG 呼び出し自体が例外 (ネットワーク等)
  | 'draft_persist_error'; // ticket_drafts への保存失敗

export type IngestInboundStatus =
  | 'ingested_with_draft'
  | 'ingested_no_draft' // 新規だが RAG が draft を出さなかった (no_answer 等)
  | 'ingested_draft_failed' // 新規だが RAG 呼び出し失敗 (ticket は保存済)
  | 'duplicate'; // 既知の channel_message_id → 何もしない

export interface IngestInboundResult {
  status: IngestInboundStatus;
  ticketId: string;
  draftId?: string;
  /** PII を含まない安定コードのみ */
  draftError?: DraftErrorCode;
}

export interface IngestInboundParams {
  channelId: string;
  ticket: NormalizedTicket;
  inboundMessage: NormalizedMessage;
  ragInput: RagReplyInput;
  /**
   * draft の source ラベル (既定 'rag')。
   * 本関数は AI 生成 draft を is_separated=true で保存するため、AI 由来 source
   * (rag / ai_draft) のみ許す。manual / first_response 等を渡すと is_separated の
   * 意味が壊れる (これらは is_separated を立てない契約) ため型で禁止する (codex review P3)。
   */
  draftSource?: 'rag' | 'ai_draft';
  /** テスト注入用。未指定なら origin-ai 経由の generateRagReply。 */
  generateReply?: (sb: SupabaseClient, input: RagReplyInput) => Promise<RagReplyResult>;
}

/**
 * inbound を冪等取込し、新規なら RAG ドラフトを生成して保存する。
 * channel_meta への失敗記録は行わない (呼び出し側が draftError を見て記録する)。
 */
export async function ingestInboundWithDraft(
  sb: SupabaseClient,
  params: IngestInboundParams,
): Promise<IngestInboundResult> {
  const generate = params.generateReply ?? generateRagReply;
  const source = params.draftSource ?? 'rag';

  const ticketId = await upsertTicket(sb, params.channelId, params.ticket);

  const { isNew } = await upsertMessageReturningNew(sb, ticketId, params.inboundMessage);
  if (!isNew) {
    return { status: 'duplicate', ticketId };
  }

  // origin-ai RAG でドラフト生成 (PII boundary は adapter 内で厳守)
  let ragResult: RagReplyResult;
  try {
    ragResult = await generate(sb, params.ragInput);
  } catch (e) {
    // 例外メッセージは外部に出さない (PII 安全)。種別のみログ。
    console.error('[ingest-inbound] rag_exception', {
      name: e instanceof Error ? e.name : 'unknown',
    });
    return { status: 'ingested_draft_failed', ticketId, draftError: 'rag_exception' };
  }

  if (!ragResult.ok) {
    return { status: 'ingested_draft_failed', ticketId, draftError: 'rag_upstream_error' };
  }

  // 構造分離 fail-closed (codex CONCERN#3 + review P2):
  //   reply-adapter は split-reply で分離済み。is_separated=true で保存してよいのは
  //   parseOk が **厳密に true** の場合のみ (parseOk が false / 未設定のいずれも不許可)。
  //   parseOk!==true の場合 ragResult.draft は信頼できない (混在の可能性) ため、
  //   絶対に保存しない (fail-closed)。draft を作らず parse 失敗として記録する。
  //   ※ parseOk===true の ragResult.draft は「顧客向け本文のみ」(parser 通過済)。
  if (ragResult.parseOk !== true) {
    return { status: 'ingested_no_draft', ticketId, draftError: 'rag_parse_failed' };
  }
  if (!ragResult.draft || !ragResult.draft.trim()) {
    // RAG は成功したが回答なし (no_answer 等)。失敗ではないが draft は保存しない。
    return { status: 'ingested_no_draft', ticketId, draftError: 'rag_no_draft' };
  }

  // 保存する body は「顧客向け本文のみ」。AI 由来 (source 既定 'rag') のため is_separated=true。
  const { data: draft, error: draftErr } = await sb
    .from('ticket_drafts')
    .insert({ ticket_id: ticketId, body: ragResult.draft, source, is_separated: true })
    .select('id')
    .single();
  if (draftErr) {
    return { status: 'ingested_draft_failed', ticketId, draftError: 'draft_persist_error' };
  }

  return { status: 'ingested_with_draft', ticketId, draftId: draft.id as string };
}
