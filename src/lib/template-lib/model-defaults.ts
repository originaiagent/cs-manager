import { resolveForTool } from './core-llm';
import { VALID_MODELS } from './ai-config';

export const MODEL_DEFAULTS = {
  content_gen: 'claude-3-5-sonnet-20240620',
  chat_analyze: 'claude-3-haiku-20240307',
  document_review: 'gpt-4o',
};

/**
 * Returns the default model ID for a specific purpose.
 * Prioritizes resolve API from origin-core, falls back to hardcoded defaults.
 */
export async function getDefaultModel(purpose: string): Promise<string> {
  try {
    const config = await resolveForTool(purpose);
    if (config.model_id) return config.model_id;
  } catch (error) {
    console.warn(`[model-defaults] Error resolving default model for ${purpose}:`, error);
  }

  // Fallback to hardcoded defaults
  return (MODEL_DEFAULTS as any)[purpose] || VALID_MODELS[0].id;
}
