/**
 * Core LLM Resolution Service
 * Centralizes AI settings (model_id, api_key, provider_id, llm_params)
 * by calling origin-core/api/llm/resolve.
 */

export interface LLMConfig {
  model_id: string;
  api_key: string;
  provider_id: string;
  llm_params: Record<string, any>;
}

const TOOL_ID = 'origintree-soumu-portal';

/**
 * Resolves AI settings for a specific purpose.
 * Calls origin-core/api/llm/resolve and falls back to local config.
 */
export async function resolveForTool(purpose: string): Promise<LLMConfig> {
  const coreApiUrl = process.env.CORE_API_URL;
  const internalApiKey = process.env.INTERNAL_API_KEY;

  if (coreApiUrl && internalApiKey) {
    try {
      const response = await fetch(`${coreApiUrl}/api/llm/resolve?tool=${TOOL_ID}&purpose=${purpose}`, {
        headers: {
          'X-Internal-API-Key': internalApiKey,
        },
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok) {
        const data = await response.json();
        return {
          model_id: data.model_id || data.model,
          api_key: data.api_key,
          provider_id: data.provider_id,
          llm_params: data.llm_params || {},
        };
      }
    } catch (error) {
      console.error(`[core-llm] Failed to resolve AI settings for ${purpose} from core:`, error);
    }
  }

  // Fallback to local environment variables
  return fetchLocalFallback(purpose);
}

/**
 * Legacy wrapper for compatibility with resolveAI
 */
export async function resolveAI(purpose: string): Promise<LLMConfig> {
  return resolveForTool(purpose);
}

function fetchLocalFallback(purpose: string): LLMConfig {
  const model_id = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20240620';
  const api_key = process.env.ANTHROPIC_API_KEY || '';
  const provider_id = model_id.startsWith('gpt') ? 'openai' : 'anthropic';

  return {
    model_id,
    api_key,
    provider_id,
    llm_params: {},
  };
}
