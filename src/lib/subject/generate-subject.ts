/**
 * 件名生成ヘルパ (origin-ai embed 経由 / prompt ハードコード禁止)
 *
 * 設計レビュー: codex APPROVE (multichannel-intake-subject-design.md §1)
 *
 * 不変条件:
 *  - AI 処理は必ず origin-ai embed (cs-reply:subject) 経由。cs に prompt を持たない。
 *  - ハードコードキーなし (EMBED_CLIENT_KEY / ORIGIN_AI_BASE_URL は既存 run-oneshot.ts 経由)。
 *  - PII 安全: raw body / 顧客情報はログ / エラーに出さない。
 *  - 例外を投げない: subject 失敗で受信 / ドラフトを壊さない (defense-in-depth)。
 *  - 冪等 (codex CONCERN#1): resolveAndPersistSubject は subject IS NULL の行のみ UPDATE。
 *    人手編集済み / 既に生成済み subject は踏み潰さない。
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  runEmbedOneshotAndPoll,
  type EmbedOneshotResult,
  type RunEmbedOneshotArgs,
} from '@/lib/embed/run-oneshot';

// re-export for consumers that need the types in function signatures
export type { EmbedOneshotResult, RunEmbedOneshotArgs };

export type SubjectKind = 'inquiry' | 'review';

export interface GenerateSubjectInput {
  /** 件名要約の素材 = 最新 inbound 本文 (raw)。マスクは origin-ai 側。ログに出さない。 */
  body: string;
  /** 件名生成対象 ticket UUID (embed target_id)。実在保証済みを渡す。 */
  ticketId: string;
  /** 種別ヒント。'review'→「レビュー返信」系の件名。既定 'inquiry'。 */
  kind?: SubjectKind;
  /** origin-ai 失敗時のフォールバック。既定 null (= 件名なし、goal 準拠)。 */
  fallback?: string | null;
  /**
   * テスト注入用。未指定なら runEmbedOneshotAndPoll (origin-ai embed cs-reply:subject)。
   * 本番では使わない。
   */
  runEmbed?: (args: RunEmbedOneshotArgs) => Promise<EmbedOneshotResult>;
}

// origin-ai oneshot の bare slug と target type (設計レビュー §1.2 準拠)
const SUBJECT_SLUG = 'cs-reply:subject';
const TARGET_TYPE = 'customer_record';
const MAX_SUBJECT_LEN = 120;

/**
 * origin-ai embed (oneshot `cs-reply:subject`) 経由で用件ベースの短い件名を生成する。
 *
 * - 商品名を件名に入れない (origin-ai 側 prompt が保証。cs に prompt を持たない)。
 * - review は「レビュー返信」等と分かる件名。
 * - 失敗 (鍵未配布 / upstream エラー / 空 / 不正 shape / 例外) は fallback (既定 null)。
 * - 例外を投げない (defense-in-depth)。raw body をログ / エラーに出さない。
 *
 * @returns 生成件名 (trim + 120 文字上限) または fallback
 */
export async function generateSubject(input: GenerateSubjectInput): Promise<string | null> {
  try {
    // ガード: 空 body / ticketId → embed を呼ばずフォールバック
    if (!input.body || !input.ticketId) {
      return input.fallback ?? null;
    }

    const run = input.runEmbed ?? runEmbedOneshotAndPoll;

    const embedResult = await run({
      slug: SUBJECT_SLUG,
      targetType: TARGET_TYPE,
      targetId: input.ticketId,
      input: {
        inquiry_text: input.body,
        subject_kind: input.kind ?? 'inquiry',
      },
    });

    if (!embedResult.ok || !embedResult.result) {
      return input.fallback ?? null;
    }

    const subject = embedResult.result.subject;

    // shape 検証: string のみ許可 (number / null / array / オブジェクト は fallback)
    if (typeof subject !== 'string' || !subject.trim()) {
      return input.fallback ?? null;
    }

    const trimmed = subject.trim();
    return trimmed.length > MAX_SUBJECT_LEN ? trimmed.slice(0, MAX_SUBJECT_LEN) : trimmed;
  } catch {
    // 例外種別はログなし (PII 安全 / 外部サービス stack を出さない)
    return input.fallback ?? null;
  }
}

/**
 * ticket.subject を generateSubject で解決し DB 更新する (単一の書き込み口)。
 *
 * 冪等 (codex CONCERN#1): UPDATE は subject IS NULL の行のみ実行する。
 * - 既に件名がある行は触らない (再 sync で再要約しない / 人手編集を踏み潰さない)。
 * - 生成が non-null のときだけ UPDATE 実行。null(失敗) 時は何もしない = 件名なし維持。
 * - 例外を投げない (subject 失敗で受信 / ドラフトを壊さない)。
 */
export async function resolveAndPersistSubject(
  sb: SupabaseClient,
  ticketId: string,
  input: {
    body: string;
    kind?: SubjectKind;
    fallback?: string | null;
    /** テスト注入用。未指定なら runEmbedOneshotAndPoll。 */
    runEmbed?: (args: RunEmbedOneshotArgs) => Promise<EmbedOneshotResult>;
  },
): Promise<void> {
  try {
    const subject = await generateSubject({
      body: input.body,
      ticketId,
      kind: input.kind,
      fallback: input.fallback,
      runEmbed: input.runEmbed,
    });

    if (!subject) return;

    // subject IS NULL の行のみ更新 (冪等ロック: 既存 subject は絶対に上書きしない)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (sb
      .from('tickets')
      .update({ subject })
      .eq('id', ticketId)
      .is('subject', null) as any);

    if (error) {
      // DB エラーは安定コードのみ記録。subject 失敗は致命でない。
      console.warn('[subject] resolveAndPersistSubject update error', {
        code: (error as { code?: string }).code ?? 'unknown',
      });
    }
  } catch (e) {
    // 外部サービス / DB の予期しない例外 — name のみ記録 (stack / body は出さない)
    console.warn('[subject] resolveAndPersistSubject threw', {
      name: e instanceof Error ? e.name : 'unknown',
    });
  }
}
