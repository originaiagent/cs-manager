/**
 * LINE webhook 純関数 単体テスト (実 DB 不要)
 *
 * (a) verifyLineSignature: 正しい secret で生成した署名を通し、誤署名/不正フォーマットを弾く
 * (b) normalizeLineTextEvent: サンプル text event を正しい NormalizedTicket/Message に変換
 *
 * HMAC は node:crypto で実際に計算する (LINE 公式の検証アルゴリズムと同一)。
 */
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyLineSignature } from '@/channels/line/verify';
import {
  isTextMessageEvent,
  normalizeLineTextEvent,
  type LineWebhookEvent,
} from '@/channels/line/normalize';

const CHANNEL_SECRET = 'test-channel-secret-abc123';

function sign(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
}

describe('verifyLineSignature', () => {
  const rawBody = JSON.stringify({
    destination: 'Uxxxxxxxx',
    events: [{ type: 'message', message: { id: '1', type: 'text', text: 'hi' } }],
  });

  it('正しい secret で生成した署名を通す', () => {
    const sig = sign(rawBody, CHANNEL_SECRET);
    expect(verifyLineSignature(rawBody, sig, CHANNEL_SECRET)).toBe(true);
  });

  it('誤った secret で生成した署名を弾く', () => {
    const sig = sign(rawBody, 'wrong-secret');
    expect(verifyLineSignature(rawBody, sig, CHANNEL_SECRET)).toBe(false);
  });

  it('body が改竄されると弾く', () => {
    const sig = sign(rawBody, CHANNEL_SECRET);
    expect(verifyLineSignature(rawBody + ' ', sig, CHANNEL_SECRET)).toBe(false);
  });

  it('署名 null / 空文字は false (throw しない)', () => {
    expect(verifyLineSignature(rawBody, null, CHANNEL_SECRET)).toBe(false);
    expect(verifyLineSignature(rawBody, '', CHANNEL_SECRET)).toBe(false);
  });

  it('channel secret 空は false', () => {
    const sig = sign(rawBody, CHANNEL_SECRET);
    expect(verifyLineSignature(rawBody, sig, '')).toBe(false);
  });

  it('長さ不正 / base64 不正の署名でも throw せず false', () => {
    expect(verifyLineSignature(rawBody, 'short', CHANNEL_SECRET)).toBe(false);
    expect(verifyLineSignature(rawBody, '!!!not-base64!!!', CHANNEL_SECRET)).toBe(false);
  });
});

describe('isTextMessageEvent', () => {
  it('text message event を true 判定', () => {
    const ev: LineWebhookEvent = {
      type: 'message',
      message: { id: 'm1', type: 'text', text: 'hello' },
      source: { type: 'user', userId: 'U1' },
      timestamp: 0,
    };
    expect(isTextMessageEvent(ev)).toBe(true);
  });

  it('非 text (sticker) / 非 message (follow) / 空 text は false', () => {
    const sticker: LineWebhookEvent = {
      type: 'message',
      message: { id: 'm1', type: 'sticker' },
      source: { type: 'user', userId: 'U1' },
      timestamp: 0,
    };
    const follow: LineWebhookEvent = {
      type: 'follow',
      source: { type: 'user', userId: 'U1' },
      timestamp: 0,
    };
    const empty: LineWebhookEvent = {
      type: 'message',
      message: { id: 'm1', type: 'text', text: '' },
      source: { type: 'user', userId: 'U1' },
      timestamp: 0,
    };
    expect(isTextMessageEvent(sticker)).toBe(false);
    expect(isTextMessageEvent(follow)).toBe(false);
    expect(isTextMessageEvent(empty)).toBe(false);
  });
});

describe('normalizeLineTextEvent', () => {
  const CHANNEL_ID = 'channel-uuid-line';
  const ts = 1_700_000_000_000;

  it('text event を正規化 (userId が externalId / channelMessageId=line:<id>)', () => {
    const ev: LineWebhookEvent = {
      type: 'message',
      message: { id: 'msg-999', type: 'text', text: '配送はいつですか' },
      source: { type: 'user', userId: 'U-customer-1' },
      replyToken: 'rt',
      timestamp: ts,
      webhookEventId: 'whe-1',
      deliveryContext: { isRedelivery: false },
    };
    const { ticket, inboundMessage, ragInput } = normalizeLineTextEvent(ev, CHANNEL_ID);

    // ticket
    expect(ticket.externalId).toBe('U-customer-1');
    expect(ticket.status).toBe('untouched');
    expect(ticket.customerName).toBeUndefined();
    expect(ticket.channelMeta).toMatchObject({
      source: 'line',
      userId: 'U-customer-1',
      webhookEventId: 'whe-1',
    });

    // inbound message
    expect(inboundMessage.channelMessageId).toBe('line:msg-999');
    expect(inboundMessage.direction).toBe('inbound');
    expect(inboundMessage.body).toBe('配送はいつですか');
    expect(inboundMessage.senderType).toBe('customer');
    expect(inboundMessage.sentAt).toBe(new Date(ts).toISOString());

    // rag input
    expect(ragInput).toEqual({
      subject: null,
      inquiryBody: '配送はいつですか',
      customerName: null,
      channelId: CHANNEL_ID,
      tenantId: null,
    });
  });

  it('userId 不在時は message.id を externalId にフォールバック', () => {
    const ev: LineWebhookEvent = {
      type: 'message',
      message: { id: 'msg-no-user', type: 'text', text: 'x' },
      source: { type: 'group' },
      timestamp: ts,
    };
    const { ticket } = normalizeLineTextEvent(ev, CHANNEL_ID);
    expect(ticket.externalId).toBe('msg-no-user');
    expect((ticket.channelMeta as Record<string, unknown>).userId).toBeNull();
  });

  it('text message でない event を渡すと throw', () => {
    const ev: LineWebhookEvent = {
      type: 'follow',
      source: { type: 'user', userId: 'U1' },
      timestamp: ts,
    };
    expect(() => normalizeLineTextEvent(ev, CHANNEL_ID)).toThrow();
  });
});
