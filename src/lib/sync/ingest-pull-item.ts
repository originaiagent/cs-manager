/**
 * pull 経路 (orchestrator / rakuten-sync) の 1 ticket 後処理の共通化。
 *
 * 責務 (codex APPROVE 設計 §2/§3.2 + CONCERN#1/#2/#3 反映):
 *  1. messages を per-message 冪等 insert し、新規 inbound を識別する。
 *  2. 新規 inbound (顧客新着) があり、かつ subject が空のときだけ origin-ai 要約で件名を設定する
 *     (subject の書込口は resolveAndPersistSubject に収束。subject IS NULL ガードで冪等)。
 *  3. autoDraft 指定チャネル (Yahoo) のみ、最新の新規 inbound に対し RAG ドラフトを生成する。
 *
 * 不変条件:
 *  - 発火は「新規に insert された inbound」だけ。outbound-only 更新・再送 (isNew=false) では発火しない。
 *  - subject / draft の失敗は受信 (ticket/message) を壊さない (try/catch で隔離)。
 *  - 件名要約・返信生成は origin-ai 経由のみ (本モジュールに prompt/LLM を持たない)。
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { NormalizedMessage } from '@/channels/_lib/types';
import { upsertMessagesReturningNew, latestInbound } from '@/lib/sync/ingest';
import {
  resolveAndPersistSubject as defaultResolveSubject,
  type SubjectKind,
} from '@/lib/subject/generate-subject';
import {
  generateDraftForNewInbound as defaultGenerateDraft,
} from '@/lib/sync/pull-auto-draft';
import type { IngestInboundStatus } from '@/lib/sync/ingest-inbound';

export interface IngestPullItemArgs {
  channelId: string;
  ticketId: string;
  /** upsertTicket が報告した「現在 subject が空か」。false なら origin-ai を呼ばない (無駄回避)。 */
  subjectEmpty: boolean;
  messages: NormalizedMessage[];
  /** ticket.channelMeta。subjectKind='review' のときレビュー返信件名にする。 */
  channelMeta?: Record<string, unknown> | null;
  customerName?: string | null;
  productId?: string | null;
  /** auto-draft を発火するか (Yahoo=true / 楽天=false: 楽天は first-response flow を使う)。 */
  autoDraft: boolean;
  /** テスト注入用。未指定なら本番実装。 */
  resolveSubject?: typeof defaultResolveSubject;
  generateDraft?: typeof defaultGenerateDraft;
}

export interface IngestPullItemResult {
  /** 新規 insert されたメッセージ総数 (inbound + outbound)。 */
  inserted: number;
  /** 新規 insert された inbound の件数。 */
  newInboundCount: number;
  /** origin-ai 件名要約を試みたか。 */
  subjectAttempted: boolean;
  /** auto-draft の結果 (発火したときのみ)。 */
  draftStatus?: IngestInboundStatus;
  /** subject / draft 中に握った非致命エラーの安定ラベル (任意・ログ用)。 */
  warnings: string[];
}

export async function ingestPullItem(
  sb: SupabaseClient,
  args: IngestPullItemArgs,
): Promise<IngestPullItemResult> {
  const resolveSubject = args.resolveSubject ?? defaultResolveSubject;
  const generateDraft = args.generateDraft ?? defaultGenerateDraft;
  const warnings: string[] = [];

  const { count: inserted, newInbound } = await upsertMessagesReturningNew(
    sb,
    args.ticketId,
    args.messages,
  );

  const latest = latestInbound(newInbound);
  let subjectAttempted = false;
  let draftStatus: IngestInboundStatus | undefined;

  // 新規 inbound (顧客新着) がないときは subject / draft を一切発火しない。
  if (latest) {
    const meta = (args.channelMeta ?? {}) as Record<string, unknown>;
    const kind: SubjectKind = meta.subjectKind === 'review' ? 'review' : 'inquiry';

    // 件名: 現 subject が空のときだけ origin-ai を呼ぶ (書込は subject IS NULL ガードで冪等)。
    if (args.subjectEmpty) {
      subjectAttempted = true;
      try {
        await resolveSubject(sb, args.ticketId, { body: latest.body, kind });
      } catch (e) {
        warnings.push(`subject:${e instanceof Error ? e.name : 'unknown'}`);
      }
    }

    // auto-draft: 最新の新規 inbound に対し RAG ドラフト生成 (fail-closed)。Yahoo のみ。
    if (args.autoDraft) {
      try {
        const r = await generateDraft(sb, {
          channelId: args.channelId,
          ticketId: args.ticketId,
          inboundBody: latest.body,
          customerName: args.customerName ?? null,
          productId: args.productId ?? null,
        });
        draftStatus = r.status;
      } catch (e) {
        warnings.push(`draft:${e instanceof Error ? e.name : 'unknown'}`);
      }
    }
  }

  return { inserted, newInboundCount: newInbound.length, subjectAttempted, draftStatus, warnings };
}
