/**
 * 営業時間外一次返信フロー — AI カテゴリ分類
 *
 * PII boundary 厳守 (codex R3 #1 / design ANNEX.2 / §5):
 *   - 不変条件: classify は **必ず masked テキストのみ** を invokeChat (= 外部 LLM へ
 *     中継される origin-ai chat) に渡す。raw 問い合わせ文を invokeChat に渡してはならない。
 *   - マスクは origin-ai の `rag-pii-mask` skill が担う **origin-ai 内部のマスキング層**
 *     である (origin-ai は AI 集約の内部サービスであり「外部」ではない。設計上の「外部」は
 *     OpenAI / Anthropic / 楽天 のみ)。raw を送ってよい相手は rag-pii-mask のみ。
 *     classify / embed / search / reply 等それ以外の経路には必ず masked を渡す。
 *   - 分類結果 (general/complaint/inquiry/urgent) のみを受け取り、raw は復元しない。
 *
 * 認証 (codex R3 #3): invokeChat は origin-ai の chat/sync エンドポイント (Bearer
 *   ORIGIN_AI_API_KEY env) を叩く。これは rag skill endpoint (/api/skills/*, X-Internal-API-Key,
 *   Core 解決) とは **別系統のエンドポイント・別認証** であり、実態 (ai-client.ts) が Bearer env
 *   である。よって chat/sync 経路は Core resolve 対象外 (rag endpoint は mask.ts で Core 解決済)。
 *
 * cs-manager 内に LLM プロンプト本文・モデル直叩きは書かない (AI 集約原則)。
 * 分類は origin-ai の chat skill にカテゴリ判定を依頼し、structured/本文から抽出する。
 */

import { invokeChat } from '@/lib/ai-client';
import { maskText } from './mask';
import {
  ALLOWED_CATEGORIES,
  normalizeCategory,
  type FirstResponseConfig,
} from './config';

export interface ClassifyResult {
  /** 正規化済みカテゴリ (general/complaint/inquiry/urgent) */
  category: string;
  /** 分類が AI 由来か fallback か */
  source: 'ai' | 'fallback';
  /** PII マスク失敗時 true (fail-closed: 分類は fallback、外部に raw を出していない) */
  maskFailed: boolean;
  error?: string;
}

/**
 * 問い合わせ文 (subject + 本文) を masked 化し、origin-ai に分類させる。
 * mask 失敗 / AI 失敗時は fallback category を返す (フロー自体は止めない設計だが、
 * 呼び出し側 orchestrator が外部送信前に flag を必ず再確認する)。
 */
export async function classifyInquiry(
  internalKey: string,
  rawSubject: string | null,
  rawBody: string,
  config: FirstResponseConfig,
): Promise<ClassifyResult> {
  const fallback = config.defaultCategory;

  const rawParts = [rawSubject?.trim(), rawBody?.trim()]
    .filter(Boolean)
    .join('\n\n');
  if (!rawParts) {
    return { category: normalizeCategory(null, fallback), source: 'fallback', maskFailed: false };
  }

  // (1) PII マスク (外部送信前に必須)
  let masked: string;
  try {
    const m = await maskText(internalKey, rawParts);
    if (m.maskFailed) {
      return {
        category: normalizeCategory(null, fallback),
        source: 'fallback',
        maskFailed: true,
        error: 'PII mask failed; classification skipped (fail-closed)',
      };
    }
    masked = m.maskedText;
  } catch (e) {
    return {
      category: normalizeCategory(null, fallback),
      source: 'fallback',
      maskFailed: true,
      error: `mask error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // (2) masked テキストのみを origin-ai に渡し category を取得 (skill 名は rag_config 駆動)
  const message = [
    `[skill: ${config.classifySkill}] 次の問い合わせ(個人情報マスク済)を 1 カテゴリに分類してください。`,
    `許可カテゴリ: ${ALLOWED_CATEGORIES.join(' / ')}`,
    'JSON {"category":"..."} のみで答えてください。推測が必要な場合は general としてください。',
    '',
    '## inquiry_masked',
    masked,
  ].join('\n');

  try {
    const res = await invokeChat(message, { agentName: '' });
    if (!res.ok) {
      return {
        category: normalizeCategory(null, fallback),
        source: 'fallback',
        maskFailed: false,
        error: res.error ?? 'classify invocation failed',
      };
    }
    const raw = extractCategory(res.structuredOutput, res.message);
    const category = normalizeCategory(raw, fallback);
    return {
      category,
      source: raw ? 'ai' : 'fallback',
      maskFailed: false,
    };
  } catch (e) {
    return {
      category: normalizeCategory(null, fallback),
      source: 'fallback',
      maskFailed: false,
      error: `classify error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

function extractCategory(
  structured: Record<string, unknown> | null | undefined,
  message: string,
): string | null {
  // structured_output 優先
  const s = structured?.category;
  if (typeof s === 'string' && s.trim()) return s.trim();

  // 本文中の JSON か裸のカテゴリ語をフォールバック抽出
  if (message) {
    const m = message.match(/"category"\s*:\s*"([^"]+)"/i);
    if (m?.[1]) return m[1].trim();
    for (const c of ALLOWED_CATEGORIES) {
      if (new RegExp(`\\b${c}\\b`, 'i').test(message)) return c;
    }
  }
  return null;
}
