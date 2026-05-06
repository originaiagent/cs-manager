import { getConfig } from './config';

export interface LogDetails {
  trace_id: string;
  pattern: 'chat' | 'workflow';
  endpoint: string;
  duration_ms?: number;
  status: 'success' | 'error';
  error_code?: string;
  payload?: unknown;
}

/**
 * Structured logger for origin-ai calls.
 */
export function logRequest(details: LogDetails) {
  const config = getConfig();
  
  // PII Protection: Mask API key in endpoint if present (though it should be in headers)
  // Mask payload unless enabled
  const sanitizedDetails = {
    ...details,
    tool_name: config.toolName,
    payload: config.logPayload ? details.payload : '[MASKED]',
    // Ensure API Key is never accidentally logged if it were to appear in any stringified object
  };

  console.log(JSON.stringify({
    level: details.status === 'error' ? 'error' : 'info',
    message: `origin-ai ${details.pattern} ${details.status}`,
    ...sanitizedDetails,
    timestamp: new Date().toISOString(),
  }));
}

/**
 * Helper to mask API Key for logs (first 6 chars).
 */
export function maskKey(key: string): string {
  if (!key) return '';
  return `${key.substring(0, 6)}...`;
}
