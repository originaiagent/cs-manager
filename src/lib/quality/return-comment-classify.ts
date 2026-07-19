/**
 * FBA返品 顧客コメント症状分類 (AI) — fba_return_symptoms 抽出
 *
 * defect-classify.ts (tickets の不良分類) の流儀を踏襲する:
 *   - PII 不変条件: 外部 LLM (origin-ai embed oneshot / 現行 invokeChat 直呼び) には
 *     **必ず maskText 済テキストのみ** を渡す。raw 顧客コメントを渡してはならない。
 *     mask 失敗時は fail-closed (外部送信せず失敗扱い、attempts は claim 時に加算済のため
 *     追加加算しない)。
 *   - internalKey (rag-pii-mask 認証) の取得経路は defect-classify.ts と同一
 *     (resolveRagInternalKey = Core 解決)。値はログに出さない。
 *   - skill 名は rag_config 駆動 (defect_classify_skill。tickets 分類と同一の skill を再利用し、
 *     語彙・プロンプト規約を分岐させない = ラベル分裂防止)。legacy 経路 (CLASSIFY_VIA_EMBED=false)
 *     でのみ実際に消費される。
 *   - 既存ラベル語彙は defect-classify.ts と同じ RPC (top_defect_cause_labels) を再利用する
 *     (ticket_defect_causes / customer_service_records.defect_type の頻出ラベル)。
 *     これにより tickets 側と症状ラベルの語彙が共有され、同義ラベルへの分裂を防ぐ
 *     (ラベル文字列の選定ロジックはこの資料化で変更していない)。
 *   - embed 経路のスキル契約 (cs-classify-return-comment-v3) は existing_labels を
 *     [{label, major_category}] で受ける (docs/ops/m2-skills.sql)。選定済みラベルの
 *     major_category は ticket_defect_causes / fba_return_symptoms の実績ペアから解決し
 *     (同一ラベルが複数 major_category で記録されている場合は最頻値を採用)、実績の無い
 *     ラベル (customer_service_records.defect_type 由来の自由記述等) は normalizeMajorCategory
 *     と同じ既定 'other' にフォールバックする。legacy 経路はラベル文字列のみ使うため
 *     (CLASSIFY_VIA_EMBED が既定 OFF のため通常運用で無駄な問い合わせにしないよう)
 *     embed 経路が有効な時のみこの解決を行う (resolveExistingLabelCategories)。
 *
 * 対象取得 (20260718000000_fba_return_symptoms.sql / claim 1件ずつ化 2026-07-19):
 *   - cs-manager は FBA 返品行そのものをローカル DB に持たない (ec-manager 保有)。
 *     毎 run ec-manager から直近ウィンドウの返品を取得し、customerComments が非空の行だけを
 *     候補 (return_key の配列) として RPC claim_fba_return_classify_batch に渡す。
 *   - RPC が候補を fba_return_classify_state へ upsert した上で「取得と同時に lease 打刻 +
 *     attempts++」を原子的に行う (tickets の claim_defect_classify_batch と同じ二重分類対策)。
 *   - **クレームは defect-classify.ts と同じく 1 件ずつ (p_limit=1)、分類の直前に行う**。
 *     まとめて CLASSIFY_BATCH_LIMIT 件を一括クレームすると、その時点で全件の attempts が
 *     加算されるため、run 予算超過で未処理のまま終わった分の retry 予算が空焼きする
 *     (defect-classify.ts で先に根治済の欠陥と同じ構造)。1 件ずつクレームすることで、
 *     予算超過後は次件をクレームしない = attempts 未消費で次 run にそのまま残せる。
 *
 * 出力 (成功時):
 *   - fba_return_symptoms へ symptoms (0〜3 件, source='ai') upsert
 *   - fba_return_classify_state.classified_at = now() (症状 0 件でも恒久リトライ防止のため設定)
 * 失敗時 (mask/AI 呼び出し失敗): classified_at は設定しない (claim 時の attempts++ が
 *   MAX_CLASSIFY_ATTEMPTS に達するまで次 run で再クレーム対象になる)。
 *
 * PII: 顧客コメント原文はどのテーブル・ログ・エラーメッセージにも書かない。
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { invokeChat } from '@/lib/ai-client';
import { maskText, resolveRagInternalKey } from '@/lib/first-response/mask';
import { fetchCustomerReturns } from '@/lib/ec-manager/client';
import { runEmbedOneshotAndPoll } from '@/lib/embed/run-oneshot';
import { fbaReturnKey } from './return-reasons';
import { mergeExistingLabels } from './defect-classify';
import {
  MAJOR_CATEGORIES,
  isMajorCategory,
  normalizeMajorCategory,
  type MajorCategory,
} from './defect-taxonomy';
import { jstTodayYmd } from './period';
import {
  classifyViaEmbed,
  validateEmbedCauseArray,
  RETURN_COMMENT_CLASSIFY_EMBED_SLUG,
  RETURN_COMMENT_CLASSIFY_EMBED_TARGET_TYPE,
  CLASSIFY_EMBED_POLL_DEADLINE_MS,
  CLASSIFY_EMBED_POLL_INTERVAL_MS,
} from './classify-embed';

/** rag_config の skill キー (tickets 分類と同一。symptom 専用の別 skill は作らない = 語彙分裂防止) */
const CLASSIFY_SKILL_CONFIG_KEY = 'defect_classify_skill';
const DEFAULT_CLASSIFY_SKILL = 'cs_defect_classify';

/** ec-manager から FBA 返品コメントを取得する直近ウィンドウ (日数) */
export const RETURN_COMMENT_WINDOW_DAYS = 35;

/** 1 run の最大クレーム件数 (tickets 分類 cron と同じ桁数)。1 件ずつクレームのループ上限。 */
const CLASSIFY_BATCH_LIMIT = 20;

/** attempts がこの値以上の return_key は対象外 (永久リトライ防止) */
const MAX_CLASSIFY_ATTEMPTS = 3;

/** クレーム lease の有効期限 (分)。tickets 分類 cron と同じ既定値 */
const LEASE_MINUTES = 15;

/** 既存ラベルのプロンプト提示上限 (プロンプト肥大防止。defect-classify.ts と同値) */
const MAX_EXISTING_LABELS = 30;

/** symptom label の防御的最大長 (AI には 15 字以内を指示、逸脱時はクランプ) */
const MAX_LABEL_LENGTH = 30;

/**
 * 1 run の時間予算 (ms)。env RETURN_COMMENT_CLASSIFY_RUN_BUDGET_MS で可変、既定 240_000。
 * defect-classify.ts の runBudgetMs と同じ理由 (route maxDuration=300s に対する安全マージン)。
 * 予算超過後は次の return_key をクレームせず打ち切る (未クレーム = attempts 未消費)。
 */
function runBudgetMs(): number {
  const raw = process.env.RETURN_COMMENT_CLASSIFY_RUN_BUDGET_MS;
  const n = raw ? parseInt(raw, 10) : NaN;
  if (Number.isFinite(n) && n >= 10_000 && n <= 600_000) return n;
  return 240_000;
}

export interface ReturnSymptom {
  label: string;
  major_category: MajorCategory;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** candidate object から symptoms を検証つきで取り出す。形不正は null。 */
function parseSymptomCandidate(candidate: unknown): ReturnSymptom[] | null {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const obj = candidate as Record<string, unknown>;
  const raw = Array.isArray(obj.symptoms) ? obj.symptoms : null;
  if (!raw) return null;

  const out: ReturnSymptom[] = [];
  const seen = new Set<string>();
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const co = c as Record<string, unknown>;
    const label =
      typeof co.label === 'string' ? co.label.trim().slice(0, MAX_LABEL_LENGTH) : '';
    if (!label || seen.has(label) || !isUsableSymptomLabel(label)) continue;
    seen.add(label);
    out.push({ label, major_category: normalizeMajorCategory(co.major_category) });
    if (out.length >= 3) break;
  }
  return out;
}

/** 症状ラベルに日本語が含まれるか (ひらがな/カタカナ/漢字/長音符) */
const JAPANESE_RE = /[぀-ゟ゠-ヿ一-鿿ー]/;

/**
 * 症状ラベルとして画面に出してよい値か。
 *
 * 実データで観測した AI の逸脱を弾く (本番実測: 76件中4件):
 *   - major_category の enum 値をそのまま label に入れてくる
 *     (例: label="description_mismatch") → 画面に生の英語が出る
 * 「日本語・15字以内・症状ベース」を指示しているので、日本語を含まないラベルは
 * 症状として使えないと判断して捨てる (major_category は別途 normalize 済みのため
 * 大分類の情報は失われない)。
 */
function isUsableSymptomLabel(label: string): boolean {
  if ((MAJOR_CATEGORIES as readonly string[]).includes(label.toLowerCase())) return false;
  return JAPANESE_RE.test(label);
}

/**
 * origin-ai 応答から症状ラベルを抽出する (structured_output 優先 → 本文 JSON フォールバック)。
 * 単体テスト対象の純関数 (defect-classify.ts の extractClassification と同じ流儀)。
 */
export function extractSymptoms(
  structured: Record<string, unknown> | null | undefined,
  message: string,
): ReturnSymptom[] {
  const fromStructured = parseSymptomCandidate(structured);
  if (fromStructured) return fromStructured;

  if (message) {
    const direct = tryParseJson(message);
    const fromDirect = parseSymptomCandidate(direct);
    if (fromDirect) return fromDirect;

    const first = message.indexOf('{');
    const last = message.lastIndexOf('}');
    if (first >= 0 && last > first) {
      const inner = tryParseJson(message.slice(first, last + 1));
      const fromInner = parseSymptomCandidate(inner);
      if (fromInner) return fromInner;
    }
  }
  return [];
}

interface ClassifyCommentResult {
  ok: boolean;
  symptoms: ReturnSymptom[];
  /** PII マスク失敗時 true (fail-closed: 外部に raw を出していない) */
  maskFailed: boolean;
  error?: string;
}

/**
 * origin-ai embed (`cs:classify-return-comment`) の run.result を fail-closed で検証する。
 *
 * 旧経路の extractSymptoms (本文JSON regexフォールバック・重複/不正要素の黙殺) とは別物:
 * symptoms は配列必須で 0〜3 件・各要素とも major_category enum 完全一致、加えて既存の
 * isUsableSymptomLabel (日本語必須・major_category enum値そのままの label 拒否) も適用する。
 * 1件でも不正要素があれば結果全体を invalid (null) にする (黙って除外しない)。単体テスト対象の純関数。
 */
export function validateEmbedReturnSymptomsResult(result: unknown): ReturnSymptom[] | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const obj = result as Record<string, unknown>;

  const symptoms = validateEmbedCauseArray(obj.symptoms);
  if (symptoms === null) return null;

  for (const s of symptoms) {
    if (!isUsableSymptomLabel(s.label)) return null;
  }
  return symptoms;
}

/**
 * 既存ラベル (mergeExistingLabels で選定済みの語彙。選定ロジック自体は変更しない) それぞれの
 * major_category を実データから解決する。embed 経路のスキル契約 (cs-classify-return-comment-v3)
 * が existing_labels を [{label, major_category}] で要求するため (docs/ops/m2-skills.sql)。
 *
 * ticket_defect_causes / fba_return_symptoms の実績ペア (cause_label, major_category) を
 * 対象ラベルに絞って合算し、ラベル毎に最頻値を採用する (同一ラベルが複数 major_category で
 * 記録されている場合は「最頻major_categoryで1本化」)。customer_service_records.defect_type
 * 由来など実績の無いラベル (major_category を持たない自由記述語彙) は normalizeMajorCategory
 * と同じ既定 'other' へフォールバックする (ハードコードではなく実データ解決が欠損した分のみ)。
 * 語彙提示はヒント用途のため、DB 取得失敗時も分類自体は続行する (fail-soft。全ラベル 'other')。
 */
async function resolveExistingLabelCategories(
  sb: SupabaseClient,
  labels: string[],
): Promise<ReturnSymptom[]> {
  if (labels.length === 0) return [];

  // 取得不能時 (throw / { data: null, error } どちらの失敗形も) は全ラベル 'other' へ
  // フォールバックする (語彙提示はヒント用途のため、解決不能でも分類自体は続行する)。
  const fallback = (): ReturnSymptom[] =>
    labels.map((label) => ({ label, major_category: 'other' as MajorCategory }));

  try {
    const [causesRes, symptomsRes] = await Promise.all([
      sb.from('ticket_defect_causes').select('cause_label, major_category').in('cause_label', labels),
      sb.from('fba_return_symptoms').select('cause_label, major_category').in('cause_label', labels),
    ]);
    // Supabase クエリは失敗時に throw せず { data: null, error } を返す (loadGlobalTopLabels と
    // 同じ流儀)。error を無視すると data=null を「実績なし」と誤認して黙って other 化してしまう
    // ため、明示的にチェックしてフォールバックする。
    if (causesRes.error || symptomsRes.error) return fallback();

    const counts = new Map<string, Map<MajorCategory, number>>();
    const bump = (label: unknown, category: unknown) => {
      if (typeof label !== 'string' || !isMajorCategory(category)) return;
      const byCategory = counts.get(label) ?? new Map<MajorCategory, number>();
      byCategory.set(category, (byCategory.get(category) ?? 0) + 1);
      counts.set(label, byCategory);
    };
    for (const row of (causesRes.data ?? []) as Array<{ cause_label: unknown; major_category: unknown }>) {
      bump(row.cause_label, row.major_category);
    }
    for (const row of (symptomsRes.data ?? []) as Array<{ cause_label: unknown; major_category: unknown }>) {
      bump(row.cause_label, row.major_category);
    }

    return labels.map((label) => {
      const byCategory = counts.get(label);
      if (!byCategory || byCategory.size === 0) return { label, major_category: 'other' as MajorCategory };
      // 最頻値を採用 (「重複labelは最頻major_categoryで1本化」)。同数タイブレークは
      // 集計順 (ticket_defect_causes → fba_return_symptoms の順に加算) の先勝ちで決定的。
      // 業務上の優先根拠があるわけではなく、あくまで安定した (=再実行しても同じ結果になる) 規則。
      let best: MajorCategory = 'other';
      let bestCount = 0;
      for (const [category, n] of byCategory) {
        if (n > bestCount) {
          best = category;
          bestCount = n;
        }
      }
      return { label, major_category: best };
    });
  } catch {
    return fallback();
  }
}

/**
 * FBA 返品の顧客コメント (raw) を masked 化し、症状抽出させる。
 * returnKey: embed 経路の target_id (fbaReturnKey で決定的に算出済の値をそのまま使う)。
 * existingLabels: 既存 cause_label 語彙 + major_category (tickets 分類と共有。ラベル分裂防止の
 *   ためプロンプトに提示。embed 経路のスキル契約が existing_labels[{label,major_category}] を
 *   要求するため object 形で受け取る。legacy 経路のプロンプトは label のみ使用する)。
 *
 * ロールバックスイッチ (G2, env `CLASSIFY_VIA_EMBED`): 既定は現行 invokeChat 直呼び経路。
 * `CLASSIFY_VIA_EMBED=true` を明示指定した時のみ origin-ai embed oneshot
 * (`cs:classify-return-comment`) 経由へ切替わる。
 */
async function classifyReturnComment(
  internalKey: string,
  returnKey: string,
  rawComment: string,
  existingLabels: ReturnSymptom[],
  classifySkill: string,
): Promise<ClassifyCommentResult> {
  const trimmed = rawComment.trim();
  if (!trimmed) {
    return { ok: false, symptoms: [], maskFailed: false, error: 'empty comment' };
  }

  // (1) PII マスク (外部送信前に必須。失敗は fail-closed。embed/legacy 共通)
  let masked: string;
  try {
    const m = await maskText(internalKey, trimmed);
    if (m.maskFailed) {
      return {
        ok: false,
        symptoms: [],
        maskFailed: true,
        error: 'PII mask failed; classification skipped (fail-closed)',
      };
    }
    masked = m.maskedText;
  } catch (e) {
    return {
      ok: false,
      symptoms: [],
      maskFailed: true,
      error: `mask error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const labels = existingLabels
    .map((l) => ({ label: l.label.trim(), major_category: l.major_category }))
    .filter((l) => l.label.length > 0)
    .slice(0, MAX_EXISTING_LABELS);

  // (2a) embed 経路 (CLASSIFY_VIA_EMBED=true 明示指定時): origin-ai oneshot `cs:classify-return-comment` を1本起動。
  //   本文JSON regexフォールバックは新経路では使わない (fail-closed 形状検証のみ)。
  if (classifyViaEmbed()) {
    const run = await runEmbedOneshotAndPoll({
      slug: RETURN_COMMENT_CLASSIFY_EMBED_SLUG,
      targetType: RETURN_COMMENT_CLASSIFY_EMBED_TARGET_TYPE,
      targetId: returnKey,
      input: {
        comment_masked: masked,
        // スキル契約 (cs-classify-return-comment-v3 / docs/ops/m2-skills.sql):
        // existing_labels は [{label, major_category}] を要求する。
        existing_labels: labels,
      },
      deadlineMs: CLASSIFY_EMBED_POLL_DEADLINE_MS,
      intervalMs: CLASSIFY_EMBED_POLL_INTERVAL_MS,
    });
    if (!run.ok || !run.result) {
      return { ok: false, symptoms: [], maskFailed: false, error: run.reason ?? 'embed_run_failed' };
    }
    const validated = validateEmbedReturnSymptomsResult(run.result);
    if (!validated) {
      return { ok: false, symptoms: [], maskFailed: false, error: 'embed_result_invalid_shape' };
    }
    return { ok: true, symptoms: validated, maskFailed: false };
  }

  // (2b) legacy 経路 (既定): 現行 invokeChat 直呼び (変更なし。プロンプトは label 文字列のみ使用)。
  const message = [
    `[skill: ${classifySkill}] 次はFBA返品時の顧客コメント(個人情報マスク済)です。製品の症状を抽出してください。`,
    '- symptoms: 0〜3件。各要素は {"label":"...","major_category":"..."}',
    `- major_category は ${MAJOR_CATEGORIES.join(' / ')} から選ぶ`,
    '- label は日本語・15字以内・症状ベース (例: 水が出ない、貼り付かない)',
    '- 既存ラベル一覧に内容が合致するものがあれば必ず既存ラベルをそのまま使う。新規ラベルは本当に該当がない時のみ',
    '- 表現が違うだけで同じ症状なら、言い換えず既存ラベルを一字一句そのまま使う',
    '- 推測・創作は禁止。コメント本文に根拠のある内容のみ使う。情報不足・症状が読み取れない場合は {"symptoms":[]} とする',
    'JSON {"symptoms":[...]} のみで答えてください。',
    ...(labels.length > 0 ? ['', '## existing_labels', ...labels.map((l) => `- ${l.label}`)] : []),
    '',
    '## comment_masked',
    masked,
  ].join('\n');

  try {
    const res = await invokeChat(message, { agentName: '' });
    if (!res.ok) {
      return { ok: false, symptoms: [], maskFailed: false, error: res.error ?? 'classify invocation failed' };
    }
    const symptoms = extractSymptoms(res.structuredOutput, res.message);
    return { ok: true, symptoms, maskFailed: false };
  } catch (e) {
    return {
      ok: false,
      symptoms: [],
      maskFailed: false,
      error: `classify error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** rag_config から skill 名を取得 (欠落時は既定値。defect-classify.ts loadClassifySkill と同一の config_key) */
async function loadClassifySkill(sb: SupabaseClient): Promise<string> {
  const { data, error } = await sb
    .from('rag_config')
    .select('config_value')
    .eq('config_key', CLASSIFY_SKILL_CONFIG_KEY)
    .maybeSingle();
  if (!error && data) {
    const v = (data as { config_value: unknown }).config_value;
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return DEFAULT_CLASSIFY_SKILL;
}

/**
 * 全体で頻出の cause ラベル語彙を取得する (RPC top_defect_cause_labels。tickets 分類と共有)。
 * 失敗しても分類自体は続行する (ラベル提示なし = fail-soft)。
 */
async function loadGlobalSymptomLabels(sb: SupabaseClient): Promise<string[]> {
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
    return [];
  }
}

/** YYYY-MM-DD に日数を加算 (UTC 演算で TZ 非依存。period.ts / defect-rate-data.ts と同じ流儀) */
function addDaysYmd(ymd: string, days: number): string {
  const [y, mo, d] = ymd.split('-').map((v) => parseInt(v, 10));
  const dt = new Date(Date.UTC(y, mo - 1, d + days));
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${mm}-${dd}`;
}

async function markClassified(sb: SupabaseClient, key: string) {
  return sb
    .from('fba_return_classify_state')
    .update({ classified_at: new Date().toISOString() })
    .eq('return_key', key);
}

export interface ReturnCommentClassificationRunResult {
  /** 今回 AI 分類を試行した return_key 数 */
  scanned: number;
  /** 症状ラベルが 1 件以上抽出でき fba_return_symptoms へ保存した件数 */
  classified: number;
  /** AI 分類は成功したが症状ラベル無し (恒久リトライ防止のため classified_at のみ設定) */
  skipped: number;
  /** mask/AI 呼び出し失敗 (attempts はクレーム時に加算済。上限到達まで次 run で再試行) */
  failed: number;
  /**
   * 時間予算 (runBudgetMs) 超過で CLASSIFY_BATCH_LIMIT 未消化のまま打ち切った場合 true。
   * 残りは未クレーム = attempts 未消費のため次 run がそのまま拾う (defect-classify.ts と同じ契約)。
   */
  stoppedByBudget: boolean;
}

/**
 * 未分類 return_key を候補配列から 1 件だけ原子的にクレームする (lease 打刻 + attempts++)。
 *
 * p_limit=1 で「クレーム直後に必ず attempt する」を保証する (defect-classify.ts の
 * claimOneTicket と同じ理由。バッチ先取りすると予算超過時に AI に渡していない return_key の
 * retry 予算が焼ける)。RPC は毎回 p_keys の upsert (on conflict do nothing) を行うため
 * 冪等 (候補配列は不変なので複数回呼んでも安全)。
 */
async function claimOneReturnKey(
  sb: SupabaseClient,
  candidateKeys: string[],
): Promise<string | null> {
  const { data, error } = await sb.rpc('claim_fba_return_classify_batch', {
    p_keys: candidateKeys,
    p_limit: 1,
    p_max_attempts: MAX_CLASSIFY_ATTEMPTS,
    p_lease_minutes: LEASE_MINUTES,
  });
  if (error) throw new Error(`claim_fba_return_classify_batch failed: ${error.message}`);
  const rows = (data ?? []) as Array<{ return_key: string }>;
  return rows[0]?.return_key ?? null;
}

/**
 * FBA 返品の顧客コメントを直近ウィンドウ分 ec-manager から取得し、非空コメントを AI 分類する。
 * cron (/api/cron/classify-return-comments) から呼ばれる。PII をログ・戻り値に含めない。
 */
export async function runReturnCommentClassification(
  sb: SupabaseClient,
): Promise<ReturnCommentClassificationRunResult> {
  const result: ReturnCommentClassificationRunResult = {
    scanned: 0,
    classified: 0,
    skipped: 0,
    failed: 0,
    stoppedByBudget: false,
  };

  const end = jstTodayYmd();
  const start = addDaysYmd(end, -(RETURN_COMMENT_WINDOW_DAYS - 1));
  const returnsRes = await fetchCustomerReturns({ start, end });
  if (!returnsRes.ok) {
    throw new Error(`fetchCustomerReturns failed: ${returnsRes.error}`);
  }

  // 非空コメントを持つ返品行のみ候補にする (return_key は cron/ページローダ共通の決定的キー)
  const commentByKey = new Map<string, string>();
  for (const row of returnsRes.rows ?? []) {
    const comment = row.customerComments?.trim();
    if (!comment) continue;
    const key = fbaReturnKey({ orderId: row.orderId, sku: row.sku, returnDate: row.returnDate });
    if (!commentByKey.has(key)) commentByKey.set(key, comment);
  }
  const candidateKeys = Array.from(commentByKey.keys());
  if (candidateKeys.length === 0) return result;

  // run 共通セットアップは **クレームより前** に解決する (defect-classify.ts と同じ理由:
  // Core 不達等でここが throw しても、まだ 1 件もクレームしていない = attempts を消費しない)
  const internalKey = await resolveRagInternalKey();
  const classifySkill = await loadClassifySkill(sb);

  const globalLabels = await loadGlobalSymptomLabels(sb);
  const existingLabels = mergeExistingLabels([], globalLabels, MAX_EXISTING_LABELS);
  // major_category 解決 (DB 往復) は embed 経路が有効な時のみ行う (legacy 経路はラベル文字列
  // のみ使用するため。CLASSIFY_VIA_EMBED は既定 OFF のため、通常運用では無駄な問い合わせを避ける)。
  const existingLabelEntries = classifyViaEmbed()
    ? await resolveExistingLabelCategories(sb, existingLabels)
    : existingLabels.map((label) => ({ label, major_category: 'other' as MajorCategory }));

  const deadline = Date.now() + runBudgetMs();

  for (let i = 0; i < CLASSIFY_BATCH_LIMIT; i++) {
    // 予算超過: 次をクレームせず打ち切る (未クレーム = attempts 未消費で次 run に残る)
    if (Date.now() >= deadline) {
      result.stoppedByBudget = true;
      break;
    }

    // クレームは 1 件ずつ、attempt の直前に行う (先取りしない)。
    const key = await claimOneReturnKey(sb, candidateKeys);
    if (!key) break; // 対象なし = 完了

    const comment = commentByKey.get(key);
    if (!comment) {
      // 理論上到達しない (クレーム対象は候補配列由来) が、フェイルセーフとして
      // 恒久リトライにしないよう classified_at を立てて終了する
      result.skipped += 1;
      await markClassified(sb, key);
      continue;
    }
    result.scanned += 1;

    const cls = await classifyReturnComment(internalKey, key, comment, existingLabelEntries, classifySkill);

    if (!cls.ok) {
      // mask 失敗 / AI 呼び出し失敗は再試行対象 (attempts はクレーム時に加算済のため
      // classified_at を立てない。MAX_CLASSIFY_ATTEMPTS 到達で自然に対象外化する)
      result.failed += 1;
      continue;
    }

    if (cls.symptoms.length === 0) {
      // AI は成功したが症状ラベル無し → 恒久リトライ防止のため classified_at のみ設定
      const { error } = await markClassified(sb, key);
      if (error) {
        result.failed += 1;
        continue;
      }
      result.skipped += 1;
      continue;
    }

    const { error: upsertErr } = await sb.from('fba_return_symptoms').upsert(
      cls.symptoms.map((s) => ({
        return_key: key,
        cause_label: s.label,
        major_category: s.major_category,
        source: 'ai',
      })),
      { onConflict: 'return_key,cause_label', ignoreDuplicates: true },
    );
    if (upsertErr) {
      result.failed += 1;
      continue;
    }

    const { error: markErr } = await markClassified(sb, key);
    if (markErr) {
      result.failed += 1;
      continue;
    }
    result.classified += 1;
  }

  return result;
}
