import { resolveForTool, LLMConfig } from './core-llm';

/**
 * Resolves Core LLM Config.
 * Prioritizes the resolve API, falls back to existing task config.
 */
export async function resolveCoreLlmConfig(purpose: string): Promise<LLMConfig> {
  const config = await resolveForTool(purpose);
  
  // If core resolve failed (no model_id or generic ID), 
  // we could add more complex task mapping fallback here if needed.
  
  return config;
}
