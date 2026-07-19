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
 * 対象取得 (20260717020000_defect_classify_claim.sql):
 *   - RPC claim_defect_classify_batch で「選択と同時に lease 打刻 + attempts++」を原子的に行う。
 *     select → AI → update の窓で併走 run が同一チケットを拾い、AI の表現揺れで同義ラベルが
 *     増殖する二重分類欠陥の根治 (実測: 「傷あり」/「傷がある」の重複)。
 *   - attempts はクレーム時点で加算済。失敗経路で再加算しない (二重加算 = 分類機会の喪失)。
 *   - **クレームは 1 件ずつ (p_limit=1)、直前に行う**。attempts++ は「消費した retry 予算」で
 *     あり、AI に投げていないチケットに課してはならない。まとめて 20 件クレームすると
 *     (a) run 共通セットアップの throw や (b) maxDuration=300s 打ち切りで、AI に一度も
 *     渡していないチケットの予算が焼ける。3 run 繰り返すと attempts>=3 で恒久的に
 *     分類対象外へ落ち、case_category=null のまま集計から静かに欠落する。
 *     → 「クレームした = 直後に必ず attempt する」を構造的に保証する (補償 update に頼らない)。
 *   - run 共通セットアップ (internalKey / skill 名) は **クレームより前** に解決する。
 *     ここでの throw は 1 件も予算を消費しない (クレーム前だから)。
 *
 * 出力 (成功時):
 *   - tickets.case_category (defect/shipping/usage/other) + classified_at=now()
 *   - defect の場合 ticket_defect_causes へ causes (1〜3 件, source='ai') insert
 *     + 後方互換で tickets.defect_type に先頭 cause の major_category 値
 * 失敗時: 追加更新なし (クレーム時の classify_attempts++ が >= 3 で対象外化)。
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { invokeChat } from '@/lib/ai-client';
import { maskText, resolveRagInternalKey } from '@/lib/first-response/mask';
import { resolveProductsByIds } from '@/lib/product-resolver';
import { runEmbedOneshotAndPoll } from '@/lib/embed/run-oneshot';
import {
  MAJOR_CATEGORIES,
  normalizeMajorCategory,
  type MajorCategory,
} from './defect-taxonomy';
import {
  classifyViaEmbed,
  validateEmbedCauseArray,
  DEFECT_CLASSIFY_EMBED_SLUG,
  DEFECT_CLASSIFY_EMBED_TARGET_TYPE,
  CLASSIFY_EMBED_POLL_DEADLINE_MS,
  CLASSIFY_EMBED_POLL_INTERVAL_MS,
} from './classify-embed';

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

/**
 * クレーム lease の有効期限 (分)。env DEFECT_CLASSIFY_LEASE_MINUTES で可変、既定 15。
 * クレーム直後に run が落ちた行を、この時間経過後に再クレーム可能へ戻す。
 * cron 間隔 (15 分) より極端に短いと処理中の行を別 run が奪うため 1〜120 分に制限。
 */
function leaseMinutes(): number {
  const raw = process.env.DEFECT_CLASSIFY_LEASE_MINUTES;
  const n = raw ? parseInt(raw, 10) : NaN;
  if (Number.isFinite(n) && n >= 1 && n <= 120) return n;
  return 15;
}

/**
 * 1 run の時間予算 (ms)。env DEFECT_CLASSIFY_RUN_BUDGET_MS で可変、既定 240_000。
 *
 * route (/api/cron/classify-defects) の maxDuration=300s に対する安全マージン。
 * 1 件の最悪値は mask (RAG_TIMEOUT_MS 既定 60s) + chat (ORIGIN_AI_TIMEOUT_MS 既定 120s) = 180s
 * あり、origin-ai が劣化すると 20 件が 300s に収まらない。予算超過後は **次のチケットを
 * クレームしない** = attempts を消費せず素の未クレーム状態で次 run に残す。
 * (クレーム済を後から補償 update で戻す方式は、補償前に落ちると結局焼けるため採らない)
 */
function runBudgetMs(): number {
  const raw = process.env.DEFECT_CLASSIFY_RUN_BUDGET_MS;
  const n = raw ? parseInt(raw, 10) : NaN;
  if (Number.isFinite(n) && n >= 10_000 && n <= 600_000) return n;
  return 240_000;
}

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
 * origin-ai embed (`cs:classify-defect`) の run.result を fail-closed で検証する。
 *
 * 旧経路の extractClassification (trim/lowercase 正規化・不正要素の黙殺) とは別物:
 * category は許可 enum に完全一致、causes は配列必須で 0〜3 件・各要素とも enum 完全一致
 * (不正要素・重複は黙って除外せず結果全体を invalid にする)。単体テスト対象の純関数。
 */
export function validateEmbedDefectResult(
  result: unknown,
): { category: CaseCategory; causes: DefectCause[] } | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const obj = result as Record<string, unknown>;

  const category = obj.category;
  if (typeof category !== 'string' || !(CASE_CATEGORIES as readonly string[]).includes(category)) {
    return null;
  }

  const causes = validateEmbedCauseArray(obj.causes);
  if (causes === null) return null;

  // defect 以外は causes を持たせない (旧経路 parseCandidate と同じ意味論。形状自体は検証済)。
  return { category: category as CaseCategory, causes: category === 'defect' ? causes : [] };
}

/**
 * 問い合わせ文 (subject + 最初の inbound 本文) を masked 化し、origin-ai に分類させる。
 * ticketId: embed 経路の target_id (実在保証済のチケット UUID)。
 * existingLabels: 同一製品の既存 cause_label 一覧 (小分け防止のためプロンプトに提示。PII 非含有の症状ラベル)。
 *
 * ロールバックスイッチ (G2, env `CLASSIFY_VIA_EMBED`): 既定は現行 invokeChat 直呼び経路
 * (本文JSON regexフォールバック込み)。`CLASSIFY_VIA_EMBED=true` を明示指定した時のみ
 * origin-ai embed oneshot (`cs:classify-defect`) 経由へ切替わる。
 */
export async function classifyDefectInquiry(
  internalKey: string,
  ticketId: string,
  rawSubject: string | null,
  rawBody: string,
  existingLabels: string[],
  classifySkill: string,
): Promise<DefectClassifyResult> {
  const rawParts = [rawSubject?.trim(), rawBody?.trim()].filter(Boolean).join('\n\n');
  if (!rawParts) {
    return { ok: false, maskFailed: false, error: 'empty inquiry text' };
  }

  // (1) PII マスク (外部送信前に必須。失敗は fail-closed。embed/legacy 共通)
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

  const labels = existingLabels
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, MAX_EXISTING_LABELS);

  // (2a) embed 経路 (CLASSIFY_VIA_EMBED=true 明示指定時): origin-ai oneshot `cs:classify-defect` を1本起動。
  //   本文JSON regexフォールバックは新経路では使わない (fail-closed 形状検証のみ)。
  if (classifyViaEmbed()) {
    const run = await runEmbedOneshotAndPoll({
      slug: DEFECT_CLASSIFY_EMBED_SLUG,
      targetType: DEFECT_CLASSIFY_EMBED_TARGET_TYPE,
      targetId: ticketId,
      input: {
        inquiry_masked: masked,
        existing_labels: labels,
        categories: CASE_CATEGORIES,
      },
      deadlineMs: CLASSIFY_EMBED_POLL_DEADLINE_MS,
      intervalMs: CLASSIFY_EMBED_POLL_INTERVAL_MS,
    });
    if (!run.ok || !run.result) {
      return { ok: false, maskFailed: false, error: run.reason ?? 'embed_run_failed' };
    }
    const validated = validateEmbedDefectResult(run.result);
    if (!validated) {
      return { ok: false, maskFailed: false, error: 'embed_result_invalid_shape' };
    }
    return { ok: true, category: validated.category, causes: validated.causes, maskFailed: false };
  }

  // (2b) legacy 経路 (既定): 現行 invokeChat 直呼び (変更なし)。
  const message = [
    `[skill: ${classifySkill}] 次の顧客問い合わせ(個人情報マスク済)を分類してください。`,
    `- category: ${CASE_CATEGORIES.join(' / ')} から1つ`,
    '- category が defect の場合のみ causes を1〜3件。各要素は {"label":"...","major_category":"..."}',
    `- major_category は ${MAJOR_CATEGORIES.join(' / ')} から選ぶ`,
    '- label は日本語・15字以内・症状ベース (例: 水が出ない)',
    '- 既存ラベル一覧に内容が合致するものがあれば必ず既存ラベルをそのまま使う。新規ラベルは本当に該当がない時のみ',
    '- 表現が違うだけで同じ症状なら、言い換えず既存ラベルを一字一句そのまま使う (例:「傷がある」と「傷あり」は同じ症状なので既存ラベル側の表記に合わせる)',
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
  /**
   * 時間予算 (runBudgetMs) 超過で batchLimit 未消化のまま打ち切った場合 true。
   * 残りは未クレーム = attempts 未消費のため次 run がそのまま拾う。
   * 恒常的に true なら origin-ai 劣化かバッチ過大のサイン (静かな取りこぼしの可視化)。
   */
  stoppedByBudget: boolean;
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
 * product スコープラベルとグローバル頻出ラベルを、提示用の 1 リストに合成する純関数。
 *
 * - product スコープを優先 (同一製品の語彙の方が合致率が高い)、残り枠をグローバルで補完
 * - trim + 重複除去 (product 側で採用済のラベルはグローバル側で再掲しない)
 * - limit でクランプ (プロンプト肥大防止)
 */
export function mergeExistingLabels(
  productLabels: string[],
  globalLabels: string[],
  limit: number = MAX_EXISTING_LABELS,
): string[] {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const merged: string[] = [];
  const seen = new Set<string>();
  // product スコープ → グローバルの順に詰める (先勝ち)
  for (const group of [productLabels, globalLabels]) {
    for (const raw of group ?? []) {
      if (merged.length >= limit) return merged;
      const label = typeof raw === 'string' ? raw.trim() : '';
      if (!label || seen.has(label)) continue;
      seen.add(label);
      merged.push(label);
    }
  }
  return merged;
}

/**
 * 全体で頻出の cause ラベル語彙を取得する (RPC top_defect_cause_labels)。
 * product_id を持たないチケット (実データで 9 割超) でも語彙提示をゼロにしないための経路。
 * 失敗しても分類自体は続行する (ラベル提示なし = fail-soft)。
 */
async function loadGlobalTopLabels(sb: SupabaseClient): Promise<string[]> {
  try {
    const { data, error } = await sb.rpc('top_defect_cause_labels', {
      p_limit: MAX_EXISTING_LABELS,
    });
    if (error) return [];
    const labels: string[] = [];
    for (const row of (data ?? []) as unknown[]) {
      const l = (row as { label?: unknown }).label;
      if (typeof l === 'string' && l.trim()) labels.push(l.trim());
    }
    return labels;
  } catch {
    // 語彙提示はヒント用途のため、取得不能でも分類は続行する
    return [];
  }
}

/**
 * 既存 cause_label 一覧 (小分け防止のプロンプト提示用) を取得する。
 * - productId ありなら同一製品スコープを優先収集
 *   (ticket_defect_causes join tickets / CSR は variation_id or 親 group_id 照合)
 * - productId の有無に関わらずグローバル頻出ラベル (RPC) で補完する。
 *   ※ productId=null で提示ゼロになると毎回新規ラベルが作られ集計不能になる (欠陥2 の根治)
 * 失敗しても分類自体は続行する (ラベル提示なし)。
 */
async function loadExistingLabels(
  sb: SupabaseClient,
  productId: string | null,
): Promise<string[]> {
  const productLabels = productId ? await loadProductScopedLabels(sb, productId) : [];
  const globalLabels = await loadGlobalTopLabels(sb);
  return mergeExistingLabels(productLabels, globalLabels);
}

/**
 * 同一製品スコープの既存 cause_label を収集する。
 * - ticket_defect_causes join tickets (同じ tickets.product_id)
 * - 同 product の customer_service_records.defect_type distinct (自由文字列)
 */
async function loadProductScopedLabels(
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
 * 未分類チケットを 1 件だけ原子的にクレームする (lease 打刻 + attempts++)。
 *
 * p_limit=1 で「クレーム直後に必ず attempt する」を保証する (バッチ先取りしない)。
 * 併走 run は skip locked / lease により同じチケットを掴まない。同一 run 内で既にクレーム
 * 済の行も lease (classify_claimed_at=now()) により次回の述語から外れるため、呼び出しを
 * 繰り返すと古い順に前進する (同じ行を掴み直してループしない)。
 * 対象取得不能は run 失敗 (ラベル語彙の fail-soft とは別扱い)。
 */
async function claimOneTicket(sb: SupabaseClient): Promise<TargetTicketRow | null> {
  const { data, error } = await sb.rpc('claim_defect_classify_batch', {
    p_limit: 1,
    p_max_attempts: MAX_CLASSIFY_ATTEMPTS,
    p_lease_minutes: leaseMinutes(),
  });
  if (error) throw new Error(`claim_defect_classify_batch failed: ${error.message}`);
  const rows = (data ?? []) as TargetTicketRow[];
  return rows[0] ?? null;
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
    stoppedByBudget: false,
  };

  // run 共通セットアップは **クレームより前** に解決する。
  // Core 不達・鍵未設定でここが throw しても、まだ 1 件もクレームしていない =
  // attempts を 1 も消費しない → Core 復旧後に全チケットがそのまま再開できる。
  // (クレーム後に置くと、AI に一度も渡していないチケットの retry 予算が焼ける)
  // 値はログに出さない。
  const internalKey = await resolveRagInternalKey();
  const classifySkill = await loadClassifySkill(sb);

  const deadline = Date.now() + runBudgetMs();
  const limit = batchLimit();

  for (let i = 0; i < limit; i++) {
    // 予算超過: 次をクレームせず打ち切る (未クレーム = attempts 未消費で次 run に残る)
    if (Date.now() >= deadline) {
      result.stoppedByBudget = true;
      break;
    }

    // クレームは 1 件ずつ、attempt の直前に行う (先取りしない)。
    // classify_attempts はこの時点で +1 済 → 以降の失敗経路で追加加算しないこと (二重加算防止)。
    const ticket = await claimOneTicket(sb);
    if (!ticket) break; // 対象なし = 完了
    result.scanned += 1;

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
      // inbound 無し (分類不能)。attempts はクレーム時に加算済のため追加加算しない
      // (加算済 = 古い順スキャンの永久ブロックは既に回避されている)
      result.skippedNoInbound += 1;
      continue;
    }

    // product_id の有無に関わらず語彙を提示する (null でもグローバル頻出ラベルで補完)
    const existingLabels = await loadExistingLabels(sb, ticket.product_id);

    const cls = await classifyDefectInquiry(
      internalKey,
      ticket.id,
      ticket.subject,
      inboundBody,
      existingLabels,
      classifySkill,
    );

    if (!cls.ok || !cls.category) {
      // attempts はクレーム時に加算済 (MAX_CLASSIFY_ATTEMPTS 到達で自然に対象外化)
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
        // attempts はクレーム時に加算済
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
