import { OriginAiConfigError } from './errors';

export interface OriginAiConfig {
  baseUrl: string;
  apiKey: string;
  toolName: string;
  defaultChatTimeoutMs: number;
  defaultWorkflowTimeoutMs: number;
  logPayload: boolean;
}

export function getConfig(): OriginAiConfig {
  const baseUrl = process.env.ORIGIN_AI_URL;
  const apiKey = process.env.ORIGIN_AI_API_KEY;
  const toolName = process.env.ORIGIN_AI_TOOL_NAME || process.env.NEXT_PUBLIC_APP_NAME || 'unknown-tool';
  const chatTimeout = process.env.ORIGIN_AI_TIMEOUT_MS 
    ? parseInt(process.env.ORIGIN_AI_TIMEOUT_MS, 10) 
    : 90000;
  const workflowTimeout = process.env.ORIGIN_AI_TIMEOUT_MS 
    ? parseInt(process.env.ORIGIN_AI_TIMEOUT_MS, 10) 
    : 270000;
  const logPayload = process.env.ORIGIN_AI_LOG_PAYLOAD === 'true';

  if (!baseUrl) {
    throw new OriginAiConfigError('ORIGIN_AI_URL is not defined');
  }

  if (!apiKey) {
    throw new OriginAiConfigError('ORIGIN_AI_API_KEY is not defined');
  }

  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    apiKey,
    toolName,
    defaultChatTimeoutMs: chatTimeout,
    defaultWorkflowTimeoutMs: workflowTimeout,
    logPayload,
  };
}
