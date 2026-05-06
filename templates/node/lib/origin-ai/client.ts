import crypto from 'node:crypto';
import { getConfig } from './config';
import { getHeaders } from './auth';
import { 
  OriginAiAuthError, 
  OriginAiClientError, 
  OriginAiNetworkError, 
  OriginAiServerError, 
  OriginAiTimeoutError, 
  OriginAiUnknownError 
} from './errors';
import { logRequest } from './logger';

export interface InvokeOptions {
  timeoutMs?: number;
  traceId?: string;
  signal?: AbortSignal;
  userId?: string;
}

export interface ChatResult {
  message: string;
  structuredOutput?: Record<string, unknown>;
  skillUsed?: { name: string; displayName?: string };
  traceId: string;
  durationMs: number;
}

export interface WorkflowResult {
  result: string;
  sessionId?: string;
  traceId: string;
  durationMs: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function requestWithRetry(
  endpoint: string,
  method: 'POST',
  body: string,
  pattern: 'chat' | 'workflow',
  options: InvokeOptions = {}
): Promise<{ data: any; durationMs: number; traceId: string }> {
  const config = getConfig();
  const traceId = options.traceId || crypto.randomUUID();
  const timeoutMs = options.timeoutMs || 
    (pattern === 'chat' ? config.defaultChatTimeoutMs : config.defaultWorkflowTimeoutMs);
  
  const headers = getHeaders(traceId);
  if (options.userId) {
    // Phase 7: Potential extension for user tracking
    (headers as any)['X-User-Id'] = options.userId;
  }

  const url = `${config.baseUrl}${endpoint}`;
  
  let attempt = 0;
  const maxNetworkRetries = 2;
  const maxServerRetries = 1;

  while (true) {
    const startTime = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    // Combine signals if provided
    let signal = controller.signal;
    if (options.signal) {
      if (typeof AbortSignal !== 'undefined' && (AbortSignal as any).any) {
        signal = (AbortSignal as any).any([controller.signal, options.signal]);
      } else {
        // Fallback for Node < 20
        options.signal.addEventListener('abort', () => controller.abort());
        if (options.signal.aborted) controller.abort();
      }
    }

    try {
      const response = await fetch(url, {
        method,
        headers: headers as any,
        body,
        signal,
      });

      clearTimeout(timeoutId);
      const durationMs = Date.now() - startTime;

      if (response.ok) {
        const data = await response.json();
        logRequest({
          trace_id: traceId,
          pattern,
          endpoint,
          duration_ms: durationMs,
          status: 'success',
          payload: data,
        });
        return { data, durationMs, traceId };
      }

      // Handle Error Responses
      const responseText = await response.text();
      let responseBody;
      try {
        responseBody = JSON.parse(responseText);
      } catch {
        responseBody = responseText;
      }

      const status = response.status;
      logRequest({
        trace_id: traceId,
        pattern,
        endpoint,
        duration_ms: durationMs,
        status: 'error',
        error_code: `HTTP_${status}`,
        payload: responseBody,
      });

      if (status === 401 || status === 403) {
        throw new OriginAiAuthError(`Authentication failed (${status})`, status, traceId);
      }

      if (status === 408 || status === 504) {
        throw new OriginAiTimeoutError('Request timed out', traceId);
      }

      if (status >= 500) {
        if (attempt < maxServerRetries) {
          attempt++;
          const backoff = Math.pow(2, attempt) * 1000 + (Math.random() * 400 - 200);
          await sleep(backoff);
          continue;
        }
        throw new OriginAiServerError(`Server error (${status})`, status, traceId, responseBody);
      }

      throw new OriginAiClientError(`Client error (${status})`, status, traceId, responseBody);

    } catch (error: any) {
      clearTimeout(timeoutId);
      const durationMs = Date.now() - startTime;

      if (error instanceof OriginAiAuthError || 
          error instanceof OriginAiServerError || 
          error instanceof OriginAiClientError ||
          error instanceof OriginAiTimeoutError) {
        throw error;
      }

      if (error.name === 'AbortError') {
        logRequest({
          trace_id: traceId,
          pattern,
          endpoint,
          duration_ms: durationMs,
          status: 'error',
          error_code: 'TIMEOUT',
        });
        throw new OriginAiTimeoutError('Request timed out or was aborted', traceId);
      }

      // Network errors (fetch rejects)
      if (attempt < maxNetworkRetries) {
        attempt++;
        const backoff = Math.pow(2, attempt) * 1000 + (Math.random() * 400 - 200);
        logRequest({
          trace_id: traceId,
          pattern,
          endpoint,
          duration_ms: durationMs,
          status: 'error',
          error_code: 'NETWORK_RETRY',
        });
        await sleep(backoff);
        continue;
      }

      logRequest({
        trace_id: traceId,
        pattern,
        endpoint,
        duration_ms: durationMs,
        status: 'error',
        error_code: 'NETWORK_ERROR',
      });
      throw new OriginAiNetworkError(error.message || 'Network error', traceId);
    }
  }
}

/**
 * Pattern A: Chat invocation
 * Sends user message directly without modification.
 *
 * Phase 7 契約依存:
 *  - endpoint path (/api/chat/sync) と payload shape ({ message }) は
 *    bf9cc6e2 (origin-ai 大掃除) 完了後に最終確認・調整が必要。
 *  - SSE streaming 対応は Phase 7 で invokeChatStream として追加予定。
 */
export async function invokeChat(
  message: string,
  options: InvokeOptions = {}
): Promise<ChatResult> {
  const { data, durationMs, traceId } = await requestWithRetry(
    '/api/chat/sync',
    'POST',
    JSON.stringify({ message }),
    'chat',
    options
  );

  return {
    message: data.message ?? '',
    structuredOutput: data.structured_output ?? data.structuredOutput,
    skillUsed: data.skill_used ?? data.skillUsed,
    traceId,
    durationMs,
  };
}

/**
 * Pattern B: Workflow invocation
 * Sends workflow ID and structured data.
 *
 * Phase 7 契約依存:
 *  - endpoint path (/api/managed-agent/run) と payload shape は
 *    bf9cc6e2 完了後に最終確認・調整が必要。
 */
export async function invokeWorkflow(
  workflowId: string,
  data: Record<string, unknown>,
  options: InvokeOptions = {}
): Promise<WorkflowResult> {
  const { data: responseData, durationMs, traceId } = await requestWithRetry(
    '/api/managed-agent/run',
    'POST',
    JSON.stringify({ workflow_id: workflowId, data }),
    'workflow',
    options
  );

  return {
    result: responseData.result ?? '',
    sessionId: responseData.session_id ?? responseData.sessionId,
    traceId,
    durationMs,
  };
}
