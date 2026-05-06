/**
 * AI API Client
 *
 * origin-ai (/api/chat/sync) 接続用の薄いラッパー。
 *
 * 認証:
 *   実装の実態 (origin-ai/dashboard/app/api/chat/sync/route.ts) は
 *   Authorization: Bearer ${INTERNAL_API_SECRET} を要求する。
 *   origintree-logi/lib/origin-ai は Phase 7 契約依存で未稼働の参考実装のため、
 *   ヘッダ名 (X-Internal-API-Key) は不採用。実態を優先する。
 *
 * Trace ID:
 *   呼び出し側で UUID を発行し、ログ追跡用にローカルで保持。
 *   X-Tool-Name は origin-ai 側で利用する識別子として送信。
 */

const ORIGIN_AI_URL = process.env.ORIGIN_AI_URL;
const ORIGIN_AI_API_KEY = process.env.ORIGIN_AI_API_KEY;
const ORIGIN_AI_TOOL_NAME = process.env.ORIGIN_AI_TOOL_NAME || 'cs-manager';
const ORIGIN_AI_TIMEOUT_MS = process.env.ORIGIN_AI_TIMEOUT_MS
  ? parseInt(process.env.ORIGIN_AI_TIMEOUT_MS, 10)
  : 90_000;

export interface ChatResult {
  ok: boolean;
  message: string;
  status?: string;
  skillUsed?: { name?: string; displayName?: string; sessionId?: string };
  structuredOutput?: Record<string, unknown> | null;
  traceId: string;
  durationMs: number;
  error?: string;
}

export async function invokeChat(message: string): Promise<ChatResult> {
  const startTime = Date.now();
  const traceId = crypto.randomUUID();

  if (!ORIGIN_AI_URL) {
    return { ok: false, message: '', traceId, durationMs: 0, error: 'ORIGIN_AI_URL is not set' };
  }
  if (!ORIGIN_AI_API_KEY) {
    return { ok: false, message: '', traceId, durationMs: 0, error: 'ORIGIN_AI_API_KEY is not set' };
  }

  const url = `${ORIGIN_AI_URL.replace(/\/$/, '')}/api/chat/sync`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ORIGIN_AI_API_KEY}`,
        'X-Tool-Name': ORIGIN_AI_TOOL_NAME,
        'X-Request-Id': traceId,
      },
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(ORIGIN_AI_TIMEOUT_MS),
    });

    const durationMs = Date.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text();
      return {
        ok: false,
        message: '',
        traceId,
        durationMs,
        error: `AI API error: ${response.status} ${response.statusText} - ${errorText}`,
      };
    }

    const data = await response.json();
    const skillRaw = data.skill_used ?? data.skillUsed;
    const skillUsed = skillRaw
      ? {
          name: skillRaw.name,
          displayName: skillRaw.display_name ?? skillRaw.displayName,
          sessionId: skillRaw.session_id ?? skillRaw.sessionId,
        }
      : undefined;

    return {
      ok: true,
      status: data.status,
      message: data.message ?? '',
      skillUsed,
      structuredOutput: data.structured_output ?? data.structuredOutput ?? null,
      traceId,
      durationMs,
    };
  } catch (error: any) {
    const durationMs = Date.now() - startTime;
    const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return {
      ok: false,
      message: '',
      traceId,
      durationMs,
      error: isTimeout
        ? `Timeout after ${ORIGIN_AI_TIMEOUT_MS}ms`
        : `Network error: ${error?.message ?? String(error)}`,
    };
  }
}
