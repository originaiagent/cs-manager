/**
 * 不良分類 (AI) — tickets.case_category 自動付与 + 不良原因 (ticket_defect_causes) 抽出
 *
 * first-response の classify.ts / mask.ts の流儀を踏襲 (defect-rate-design.md PART C1-6):
 *   - PII 不変条件: invokeChat (= 外部 LLM へ中継される origin-ai chat) には
 *     **必ず maskText 済テキストのみ** を渡す。raw 問い合わせ文を渡してはならない。
 *     mask 失敗時は fail-closed (外部送信せず失敗扱い、classify_attempts++)。
 *   - internalKey (rag-pii-mask 認証) の取得経路は first-response orchestrator と同一
 *     (resolveRagInternalKey = Core 解決)。値はログに出さない。
 *   - skill 名は rag_config 駆動 (ハードコード禁止)。LLM プロンプト実体は origin-ai 側。
 *   - first_response の category (general/complaint/...) とは別物。first-response の
 *     audit テーブル等には触らない。
 *
 * 出力 (成功時):
 *   - tickets.case_category (defect/shipping/usage/other) + classified_at=now()
 *   - defect の場合 ticket_defect_causes へ causes (1〜3 件, source='ai') insert
 *     + 後方互換で tickets.defect_type に先頭 cause の major_category 値
 * 失敗時: tickets.classify_attempts++ (>= 3 で対象外化)。
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { invokeChat } from '@/lib/ai-client';
import { maskText, resolveRagInternalKey } from '@/lib/first-response/mask';
import { resolveProductsByIds } from '@/lib/product-resolver';
import {
  MAJOR_CATEGORIES,
  normalizeMajorCategory,
  type MajorCategory,
} from './defect-taxonomy';

/** tickets.case_category の許可値 (format.ts CASE_CATEGORY_LABELS と同一キー) */
export const CASE_CATEGORIES = ['defect', 'shipping', 'usage', 'other'] as const;
export type CaseCategory = (typeof CASE_CATEGORIES)[number];

/** skill 名の既定値 (rag_config 欠落時のみ。first-response config.ts と同じ流儀) */
const DEFAULT_DEFECT_CLASSIFY_SKILL = 'cs_defect_classify';

/** 1 run の最大処理件数 (env DEFECT_CLASSIFY_BATCH_LIMIT で可変、既定 20) */
function batchLimit(): number {
  const raw = process.env.DEFECT_CLASSIFY_BATCH_LIMIT;
  const n = raw ? parseInt(raw, 10) : NaN;
  if (Number.isFinite(n) && n >= 1 && n <= 100) return n;
  return 20;
}

/** classify_attempts がこの値以上のチケットは対象外 (永久リトライ防止) */
const MAX_CLASSIFY_ATTEMPTS = 3;

/** 既存ラベルのプロンプト提示上限 (プロンプト肥大防止) */
const MAX_EXISTING_LABELS = 30;

/** cause label の防御的最大長 (AI には 15 字以内を指示、逸脱時はクランプ) */
const MAX_CAUSE_LABEL_LENGTH = 30;

export interface DefectCause {
  label: string;
  major_category: MajorCategory;
}

export interface ExtractedClassification {
  /** 許可値に正規化済みの case_category。抽出不能なら null (= 分類失敗) */
  category: CaseCategory | null;
  /** category='defect' の時のみ 1〜3 件。それ以外は空配列 */
  causes: DefectCause[];
}

/**
 * origin-ai 応答から分類結果を抽出する (structured_output 優先 → 本文 JSON フォールバック)。
 * 単体テスト対象の純関数。
 */
export function extractClassification(
  structured: Record<string, unknown> | null | undefined,
  message: string,
): ExtractedClassification {
  // structured_output 優先
  const fromStructured = parseCandidate(structured);
  if (fromStructured) return fromStructured;

  // 本文中の JSON をフォールバック抽出 (コードフェンス等の前後テキストを許容)
  if (message) {
    const direct = tryParseJson(message);
    const fromDirect = parseCandidate(direct);
    if (fromDirect) return fromDirect;

    const first = message.indexOf('{');
    const last = message.lastIndexOf('}');
    if (first >= 0 && last > first) {
      const inner = tryParseJson(message.slice(first, last + 1));
      const fromInner = parseCandidate(inner);
      if (fromInner) return fromInner;
    }
  }
  return { category: null, causes: [] };
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** candidate object から category / causes を検証つきで取り出す。category 不正は null 扱い。 */
function parseCandidate(candidate: unknown): ExtractedClassification | null {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const obj = candidate as Record<string, unknown>;

  const rawCategory = typeof obj.category === 'string' ? obj.category.trim().toLowerCase() : '';
  if (!(CASE_CATEGORIES as readonly string[]).includes(rawCategory)) return null;
  const category = rawCategory as CaseCategory;

  if (category !== 'defect') return { category, causes: [] };

  const causes: DefectCause[] = [];
  const seen = new Set<string>();
  const rawCauses = Array.isArray(obj.causes) ? obj.causes : [];
  for (const c of rawCauses) {
    if (!c || typeof c !== 'object') continue;
    const co = c as Record<string, unknown>;
    const label =
      typeof co.label === 'string' ? co.label.trim().slice(0, MAX_CAUSE_LABEL_LENGTH) : '';
    if (!label || seen.has(label)) continue;
    seen.add(label);
    causes.push({ label, major_category: normalizeMajorCategory(co.major_category) });
    if (causes.length >= 3) break;
  }
  return { category, causes };
}

export interface DefectClassifyResult {
  ok: boolean;
  category?: CaseCategory;
  causes?: DefectCause[];
  /** PII マスク失敗時 true (fail-closed: 外部に raw を出していない) */
  maskFailed: boolean;
  error?: string;
}

/**
 * 問い合わせ文 (subject + 最初の inbound 本文) を masked 化し、origin-ai に分類させる。
 * existingLabels: 同一製品の既存 cause_label 一覧 (小分け防止のためプロンプトに提示。PII 非含有の症状ラベル)。
 */
export async function classifyDefectInquiry(
  internalKey: string,
  rawSubject: string | null,
  rawBody: string,
  existingLabels: string[],
  classifySkill: string,
): Promise<DefectClassifyResult> {
  const rawParts = [rawSubject?.trim(), rawBody?.trim()].filter(Boolean).join('\n\n');
  if (!rawParts) {
    return { ok: false, maskFailed: false, error: 'empty inquiry text' };
  }

  // (1) PII マスク (外部送信前に必須。失敗は fail-closed)
  let masked: string;
  try {
    const m = await maskText(internalKey, rawParts);
    if (m.maskFailed) {
      return {
        ok: false,
        maskFailed: true,
        error: 'PII mask failed; classification skipped (fail-closed)',
      };
    }
    masked = m.maskedText;
  } catch (e) {
    return {
      ok: false,
      maskFailed: true,
      error: `mask error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // (2) masked テキストのみを origin-ai に渡す (skill 名は rag_config 駆動)
  const labels = existingLabels
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, MAX_EXISTING_LABELS);
  const message = [
    `[skill: ${classifySkill}] 次の顧客問い合わせ(個人情報マスク済)を分類してください。`,
    `- category: ${CASE_CATEGORIES.join(' / ')} から1つ`,
    '- category が defect の場合のみ causes を1〜3件。各要素は {"label":"...","major_category":"..."}',
    `- major_category は ${MAJOR_CATEGORIES.join(' / ')} から選ぶ`,
    '- label は日本語・15字以内・症状ベース (例: 水が出ない)',
    '- 既存ラベル一覧に内容が合致するものがあれば必ず既存ラベルをそのまま使う。新規ラベルは本当に該当がない時のみ',
    '- 推測・創作は禁止。本文に根拠のある内容のみ使う。判断できない場合は {"category":"other"} とする',
    'JSON {"category":"...","causes":[...]} のみで答えてください。',
    ...(labels.length > 0 ? ['', '## existing_labels', ...labels.map((l) => `- ${l}`)] : []),
    '',
    '## inquiry_masked',
    masked,
  ].join('\n');

  try {
    const res = await invokeChat(message, { agentName: '' });
    if (!res.ok) {
      return { ok: false, maskFailed: false, error: res.error ?? 'classify invocation failed' };
    }
    const extracted = extractClassification(res.structuredOutput, res.message);
    if (!extracted.category) {
      return { ok: false, maskFailed: false, error: 'classification not extractable' };
    }
    return { ok: true, category: extracted.category, causes: extracted.causes, maskFailed: false };
  } catch (e) {
    return {
      ok: false,
      maskFailed: false,
      error: `classify error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

interface TargetTicketRow {
  id: string;
  subject: string | null;
  product_id: string | null;
  classify_attempts: number;
}

export interface DefectClassificationRunResult {
  /** 今回スキャンした対象チケット数 */
  scanned: number;
  /** 分類成功 (case_category 書込み) 件数 */
  classified: number;
  /** 分類失敗 (classify_attempts++) 件数 */
  failed: number;
  /** inbound message 無しでスキップ (attempts++ で再スキャン抑止) した件数 */
  skippedNoInbound: number;
}

/** rag_config から skill 名を取得 (欠落時は既定値。first-response config.ts と同じ流儀) */
async function loadClassifySkill(sb: SupabaseClient): Promise<string> {
  const { data, error } = await sb
    .from('rag_config')
    .select('config_value')
    .eq('config_key', 'defect_classify_skill')
    .maybeSingle();
  if (!error && data) {
    const v = (data as { config_value: unknown }).config_value;
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return DEFAULT_DEFECT_CLASSIFY_SKILL;
}

/**
 * 同一製品の既存 cause_label 一覧 (小分け防止のプロンプト提示用) を取得する。
 * - ticket_defect_causes join tickets (同じ tickets.product_id)
 * - 同 product の customer_service_records.defect_type distinct (自由文字列)
 * 失敗しても分類自体は続行する (ラベル提示なし)。
 */
async function loadExistingLabels(
  sb: SupabaseClient,
  productId: string,
): Promise<string[]> {
  const labels = new Set<string>();

  const { data: causeRows } = await sb
    .from('ticket_defect_causes')
    .select('cause_label, tickets!inner(product_id)')
    .eq('tickets.product_id', productId)
    .limit(200);
  for (const row of causeRows ?? []) {
    const l = (row as { cause_label?: unknown }).cause_label;
    if (typeof l === 'string' && l.trim()) labels.add(l.trim());
  }

  // CSR の ID 空間: variation_id = 子 products.id / product_id = 親 product_groups.id (PR-EF 以降)。
  // tickets.product_id は子 products.id なので variation_id と同一空間で照合し、
  // 親 group_id は Core 解決できた時のみ併用する (子 id を product_id 列と直接比較すると
  // 独立連番どうしの数値衝突で別商品のラベルを拾うため行わない)。
  const pidNum = Number(productId);
  if (Number.isFinite(pidNum)) {
    let orExpr = `variation_id.eq.${pidNum}`;
    try {
      const resolved = await resolveProductsByIds([productId]);
      const gidNum = Number(resolved.get(productId)?.group_id);
      if (Number.isFinite(gidNum)) orExpr += `,product_id.eq.${gidNum}`;
    } catch {
      // Core 不達時は variation_id 照合のみで続行 (プロンプトヒント用途のため fail-soft)
    }
    const { data: csrRows } = await sb
      .from('customer_service_records')
      .select('defect_type')
      .or(orExpr)
      .not('defect_type', 'is', null)
      .limit(200);
    for (const row of csrRows ?? []) {
      const l = (row as { defect_type?: unknown }).defect_type;
      if (typeof l === 'string' && l.trim()) labels.add(l.trim());
    }
  }

  return Array.from(labels);
}

/**
 * 未分類チケット (case_category is null) を古い順に最大 batchLimit 件 AI 分類する。
 * cron (/api/cron/classify-defects) から呼ばれる。PII をログ・戻り値に含めない。
 */
export async function runDefectClassification(
  sb: SupabaseClient,
): Promise<DefectClassificationRunResult> {
  const result: DefectClassificationRunResult = {
    scanned: 0,
    classified: 0,
    failed: 0,
    skippedNoInbound: 0,
  };

  const { data: ticketRows, error: selErr } = await sb
    .from('tickets')
    .select('id, subject, product_id, classify_attempts')
    .is('case_category', null)
    .lt('classify_attempts', MAX_CLASSIFY_ATTEMPTS)
    .order('created_at', { ascending: true })
    .limit(batchLimit());
  if (selErr) throw new Error(`target tickets select failed: ${selErr.message}`);

  const targets = (ticketRows ?? []) as TargetTicketRow[];
  result.scanned = targets.length;
  if (targets.length === 0) return result;

  // origin-ai 認証鍵 (Core 解決、first-response orchestrator と同一経路)。値はログに出さない。
  const internalKey = await resolveRagInternalKey();
  const classifySkill = await loadClassifySkill(sb);

  for (const ticket of targets) {
    // 最初の inbound message 本文 (raw。外部にはマスク後のみ送る)
    const { data: msg } = await sb
      .from('messages')
      .select('body')
      .eq('ticket_id', ticket.id)
      .eq('direction', 'inbound')
      .order('sent_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    const inboundBody = (msg as { body?: string } | null)?.body ?? '';

    if (!inboundBody.trim() && !ticket.subject?.trim()) {
      // inbound 無し (分類不能)。attempts++ で古い順スキャンの永久ブロックを防ぐ
      await bumpAttempts(sb, ticket);
      result.skippedNoInbound += 1;
      continue;
    }

    const existingLabels = ticket.product_id
      ? await loadExistingLabels(sb, ticket.product_id)
      : [];

    const cls = await classifyDefectInquiry(
      internalKey,
      ticket.subject,
      inboundBody,
      existingLabels,
      classifySkill,
    );

    if (!cls.ok || !cls.category) {
      await bumpAttempts(sb, ticket);
      result.failed += 1;
      continue;
    }

    // defect の場合は先に causes を insert (冪等 upsert)、成功後に ticket を確定
    const causes = cls.category === 'defect' ? (cls.causes ?? []) : [];
    if (causes.length > 0) {
      const { error: causeErr } = await sb.from('ticket_defect_causes').upsert(
        causes.map((c) => ({
          ticket_id: ticket.id,
          cause_label: c.label,
          major_category: c.major_category,
          source: 'ai',
        })),
        { onConflict: 'ticket_id,cause_label', ignoreDuplicates: true },
      );
      if (causeErr) {
        await bumpAttempts(sb, ticket);
        result.failed += 1;
        continue;
      }
    }

    const update: Record<string, unknown> = {
      case_category: cls.category,
      classified_at: new Date().toISOString(),
    };
    // 後方互換: 旧 defect_type 列に先頭 cause の major_category 値を書く
    if (cls.category === 'defect' && causes.length > 0) {
      update.defect_type = causes[0].major_category;
    }
    const { error: updErr } = await sb.from('tickets').update(update).eq('id', ticket.id);
    if (updErr) {
      result.failed += 1;
      continue;
    }
    result.classified += 1;
  }

  return result;
}

/** 分類失敗時のリトライカウント加算 (>= MAX_CLASSIFY_ATTEMPTS で対象外化) */
async function bumpAttempts(sb: SupabaseClient, ticket: TargetTicketRow): Promise<void> {
  await sb
    .from('tickets')
    .update({ classify_attempts: ticket.classify_attempts + 1 })
    .eq('id', ticket.id);
}
