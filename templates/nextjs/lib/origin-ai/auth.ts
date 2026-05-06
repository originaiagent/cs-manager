import { getConfig } from './config';

export interface OriginAiHeaders {
  'X-Internal-API-Key': string;
  'X-Tool-Name': string;
  'X-Request-Id': string;
  'Content-Type': string;
}

/**
 * Generates the necessary headers for an origin-ai request.
 */
export function getHeaders(traceId: string): OriginAiHeaders {
  const config = getConfig();
  return {
    'X-Internal-API-Key': config.apiKey,
    'X-Tool-Name': config.toolName,
    'X-Request-Id': traceId,
    'Content-Type': 'application/json',
  };
}
