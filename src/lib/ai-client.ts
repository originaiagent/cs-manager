/**
 * AI API Client
 * 
 * ORIGIN_AI_URL / ORIGIN_AI_API_KEY を使用して origin-ai に接続します。
 */

const ORIGIN_AI_URL = process.env.ORIGIN_AI_URL || 'https://origin-ai-five.vercel.app';
const ORIGIN_AI_API_KEY = process.env.ORIGIN_AI_API_KEY;
const ORIGIN_AI_TOOL_NAME = process.env.ORIGIN_AI_TOOL_NAME || 'cs-manager';

export interface ChatResult {
  message: string;
  traceId: string;
  durationMs: number;
  ok: boolean;
  error?: string;
}

export async function invokeChat(message: string): Promise<ChatResult> {
  if (!ORIGIN_AI_API_KEY) {
    return { ok: false, message: '', traceId: '', durationMs: 0, error: 'ORIGIN_AI_API_KEY is not set' };
  }

  const url = `${ORIGIN_AI_URL}/api/chat/sync`;
  const startTime = Date.now();
  const traceId = crypto.randomUUID();

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ORIGIN_AI_API_KEY}`,
        'X-Trace-Id': traceId,
        'X-Tool-Name': ORIGIN_AI_TOOL_NAME,
      },
      body: JSON.stringify({ message }),
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
    return {
      ok: true,
      message: data.message || '',
      traceId: data.traceId || traceId,
      durationMs,
    };
  } catch (error: any) {
    return {
      ok: false,
      message: '',
      traceId,
      durationMs: Date.now() - startTime,
      error: `Network error: ${error.message}`,
    };
  }
}
