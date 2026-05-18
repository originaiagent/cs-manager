/**
 * Core LLM Resolution Service
 *
 * - origin-core `/api/llm/resolve` を唯一の解決経路とする (env fallback 撤去)
 * - 失敗時 (env 未設定 / non-OK / JSON 不正) は loud throw
 * - 既存の `resolveAI` ラッパも残置 (互換)
 *
 * 設計レビュー: codex APPROVE (2026-05-18, Wave 2 A 修正版 v2)
 *   - fetchLocalFallback (ANTHROPIC_API_KEY / ANTHROPIC_MODEL 直参照) を撤去し fail-closed 化
 *   - goal #3「コード env 直参照ゼロ」達成
 */

export interface LLMConfig {
  model_id: string;
  api_key: string;
  provider_id: string;
  llm_params: Record<string, any>;
}

const TOOL_ID = 'cs-manager';
const RESOLVE_TIMEOUT_MS = 10_000;

export class LLMResolveError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'LLMResolveError';
  }
}

/**
 * Resolves AI settings for a specific purpose via origin-core.
 * Fail-closed: env fallback は撤去済。Core が応答しない場合は throw する。
 */
export async function resolveForTool(purpose: string): Promise<LLMConfig> {
  const coreApiUrl = process.env.CORE_API_URL?.replace(/\s+$/, '');
  const internalApiKey = process.env.INTERNAL_API_KEY?.replace(/\s+$/, '');

  if (!coreApiUrl) {
    throw new LLMResolveError('CORE_API_URL is not set');
  }
  if (!internalApiKey) {
    throw new LLMResolveError('INTERNAL_API_KEY is not set');
  }

  const url = `${coreApiUrl.replace(/\/$/, '')}/api/llm/resolve?tool=${encodeURIComponent(TOOL_ID)}&purpose=${encodeURIComponent(purpose)}`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'X-Internal-API-Key': internalApiKey },
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
    });
  } catch (err) {
    throw new LLMResolveError(
      `Core /api/llm/resolve への接続に失敗しました (purpose=${purpose})`,
      err,
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new LLMResolveError(
      `Core /api/llm/resolve が ${response.status} を返しました (purpose=${purpose}): ${body.slice(0, 300)}`,
    );
  }

  let data: any;
  try {
    data = await response.json();
  } catch (err) {
    throw new LLMResolveError(
      `Core /api/llm/resolve のレスポンス JSON 解析に失敗しました (purpose=${purpose})`,
      err,
    );
  }

  const model_id = data.model_id || data.model;
  const api_key = data.api_key;
  const provider_id = data.provider_id;
  if (!model_id || !api_key || !provider_id) {
    throw new LLMResolveError(
      `Core /api/llm/resolve のレスポンスに必須フィールドが不足しています (purpose=${purpose})`,
    );
  }

  return {
    model_id,
    api_key,
    provider_id,
    llm_params: data.llm_params || {},
  };
}

/**
 * Legacy wrapper for compatibility with resolveAI
 */
export async function resolveAI(purpose: string): Promise<LLMConfig> {
  return resolveForTool(purpose);
}
