/**
 * LINE Messaging API client 単体テスト。
 *
 * (a) pushMessage: 正しい URL/method/Authorization/X-Line-Retry-Key/body を送る (fetch 注入)。
 *     200 で sentMessages[0].id / x-line-request-id を拾う。409 で accepted-request-id を拾う。
 *     network/timeout は LineTransportError を throw。
 * (b) classifyLineSend / isMonthlyLimitExceeded: ステータス分類 (純関数)。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  LineMessagingClient,
  classifyLineSend,
  isMonthlyLimitExceeded,
} from '@/channels/line/client';
import { LineTransportError } from '@/channels/line/types';

function res(body: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

describe('LineMessagingClient.pushMessage', () => {
  it('正しい URL/method/Authorization/RetryKey/body で push する', async () => {
    let captured: { url: any; init: any } | null = null;
    const fetchMock = vi.fn(async (url: any, init: any) => {
      captured = { url, init };
      return res(JSON.stringify({ sentMessages: [{ id: 'm1' }] }), 200, {
        'x-line-request-id': 'req-1',
      });
    });
    const client = new LineMessagingClient({
      credentials: { channel_access_token: 'tok' },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const r = await client.pushMessage({ to: 'U1', text: 'こんにちは', retryKey: 'rk-1' });

    expect(captured!.url).toBe('https://api.line.me/v2/bot/message/push');
    expect(captured!.init.method).toBe('POST');
    expect(captured!.init.headers.Authorization).toBe('Bearer tok');
    expect(captured!.init.headers['X-Line-Retry-Key']).toBe('rk-1');
    expect(captured!.init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(captured!.init.body)).toEqual({
      to: 'U1',
      messages: [{ type: 'text', text: 'こんにちは' }],
    });
    expect(r.status).toBe(200);
    expect(r.sentMessageId).toBe('m1');
    expect(r.requestId).toBe('req-1');
  });

  it('200 で sentMessages が無くても落ちず id は null', async () => {
    const client = new LineMessagingClient({
      credentials: { channel_access_token: 'tok' },
      fetchImpl: (async () => res('{}', 200)) as unknown as typeof fetch,
    });
    const r = await client.pushMessage({ to: 'U1', text: 'x', retryKey: 'rk' });
    expect(r.status).toBe(200);
    expect(r.sentMessageId).toBeNull();
  });

  it('409 で x-line-accepted-request-id を拾う', async () => {
    const client = new LineMessagingClient({
      credentials: { channel_access_token: 'tok' },
      fetchImpl: (async () =>
        res('{}', 409, { 'x-line-accepted-request-id': 'acc-9' })) as unknown as typeof fetch,
    });
    const r = await client.pushMessage({ to: 'U1', text: 'x', retryKey: 'rk' });
    expect(r.status).toBe(409);
    expect(r.acceptedRequestId).toBe('acc-9');
  });

  it('HTTP エラーでも throw せず status を返す (分類は呼び出し側)', async () => {
    const client = new LineMessagingClient({
      credentials: { channel_access_token: 'tok' },
      fetchImpl: (async () => res(JSON.stringify({ message: 'blocked' }), 403)) as unknown as typeof fetch,
    });
    const r = await client.pushMessage({ to: 'U1', text: 'x', retryKey: 'rk' });
    expect(r.status).toBe(403);
    expect(r.rawBody).toContain('blocked');
  });

  it('network 障害は LineTransportError を throw', async () => {
    const client = new LineMessagingClient({
      credentials: { channel_access_token: 'tok' },
      fetchImpl: (async () => {
        throw Object.assign(new Error('socket hang up'), { name: 'TypeError' });
      }) as unknown as typeof fetch,
    });
    await expect(client.pushMessage({ to: 'U1', text: 'x', retryKey: 'rk' })).rejects.toBeInstanceOf(
      LineTransportError,
    );
  });
});

describe('classifyLineSend', () => {
  it('2xx / 409 は sent', () => {
    expect(classifyLineSend(200, '')).toBe('sent');
    expect(classifyLineSend(409, '')).toBe('sent');
  });
  it('5xx は transient', () => {
    expect(classifyLineSend(500, '')).toBe('transient');
    expect(classifyLineSend(503, '')).toBe('transient');
  });
  it('429 rate-limit は transient、月間上限は permanent', () => {
    expect(classifyLineSend(429, '{"message":"Too Many Requests"}')).toBe('transient');
    expect(classifyLineSend(429, '{"message":"You have reached your monthly limit."}')).toBe(
      'permanent',
    );
  });
  it('その他 4xx は permanent', () => {
    expect(classifyLineSend(400, '')).toBe('permanent');
    expect(classifyLineSend(401, '')).toBe('permanent');
    expect(classifyLineSend(403, '')).toBe('permanent');
    expect(classifyLineSend(404, '')).toBe('permanent');
  });
});

describe('isMonthlyLimitExceeded', () => {
  it('monthly limit 文言を検出 (大文字小文字無視)', () => {
    expect(isMonthlyLimitExceeded('You have reached your monthly limit.')).toBe(true);
    expect(isMonthlyLimitExceeded('MONTHLY  LIMIT')).toBe(true);
    expect(isMonthlyLimitExceeded('Too Many Requests')).toBe(false);
  });
});
