/**
 * LINE 送信認証ヘッダ buildLineAuthHeader 単体テスト (純関数)。
 */
import { describe, it, expect } from 'vitest';
import { buildLineAuthHeader } from '@/channels/line/auth';

describe('buildLineAuthHeader', () => {
  it('channel_access_token から Bearer ヘッダを作る', () => {
    expect(buildLineAuthHeader({ channel_access_token: 'abc.def' })).toBe('Bearer abc.def');
  });

  it('camelCase channelAccessToken も許容', () => {
    expect(buildLineAuthHeader({ channelAccessToken: 'tok123' })).toBe('Bearer tok123');
  });

  it('末尾空白を除去する', () => {
    expect(buildLineAuthHeader({ channel_access_token: 'tok  \n' })).toBe('Bearer tok');
  });

  it('token 欠落は throw', () => {
    expect(() => buildLineAuthHeader({})).toThrow(/channel_access_token is missing/);
    expect(() => buildLineAuthHeader({ channel_access_token: '' })).toThrow();
  });
});
