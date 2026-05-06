import { VALID_MODELS } from './ai-config';

export interface Provider {
  id: string;
  name: string;
}

const FALLBACK_PROVIDERS: Provider[] = [
  { id: 'anthropic', name: 'Anthropic' },
  { id: 'openai', name: 'OpenAI' },
  { id: 'google', name: 'Google' },
];

/**
 * Loads LLM providers from Core API, falls back to hardcoded list.
 */
export async function loadProviders(): Promise<Provider[]> {
  const coreApiUrl = process.env.CORE_API_URL;
  const internalApiKey = process.env.INTERNAL_API_KEY;

  if (coreApiUrl && internalApiKey) {
    try {
      const response = await fetch(`${coreApiUrl}/api/llm/providers`, {
        headers: {
          'X-Internal-API-Key': internalApiKey,
        },
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        return await response.json();
      }
    } catch (error) {
      console.warn('[llm-client] Failed to load providers from core:', error);
    }
  }

  // Fallback to local hardcoded list
  return FALLBACK_PROVIDERS;
}

/**
 * Loads LLM models, prioritized from Core API.
 */
export async function loadModels(): Promise<any[]> {
  const coreApiUrl = process.env.CORE_API_URL;
  const internalApiKey = process.env.INTERNAL_API_KEY;

  if (coreApiUrl && internalApiKey) {
    try {
      const response = await fetch(`${coreApiUrl}/api/llm/models-list`, {
        headers: {
          'X-Internal-API-Key': internalApiKey,
        },
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        return await response.json();
      }
    } catch (error) {
      console.warn('[llm-client] Failed to load models from core:', error);
    }
  }

  // Fallback to local hardcoded list
  return VALID_MODELS;
}
