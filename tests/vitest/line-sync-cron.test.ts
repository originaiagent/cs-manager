/**
 * /api/cron/line-sync ルートの認可ゲート + 送信委譲 スモークテスト。
 *
 * - ルートモジュールが実行時に読み込めること (import 解決 = build 相当の最低限の検証)。
 * - tier='cron' 認可: 認証無しは 401。
 * - 正常認可 (Bearer CRON_SECRET) で active line channel をループし sendApprovedLineDrafts を呼ぶ。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// DB と送信本体をモック (ルートの glue 挙動のみ検証)
const sendMock = vi.fn();
vi.mock('@/channels/line/outbound', () => ({
  sendApprovedLineDrafts: (...args: unknown[]) => sendMock(...args),
}));

const fromMock = vi.fn();
vi.mock('@/lib/db/supabase-admin', () => ({
  getSupabaseAdmin: async () => ({ from: fromMock }),
}));

import { GET } from '../../app/api/cron/line-sync/route';

const OLD_ENV = { ...process.env };

beforeEach(() => {
  process.env.CRON_SECRET = 'test-cron-secret';
  delete process.env.DIAG_TOKEN;
  sendMock.mockReset();
  fromMock.mockReset();
  // channels テーブル select チェーン: active+line を 1 件返す
  fromMock.mockReturnValue({
    select: () => ({
      eq: () => ({
        eq: () => Promise.resolve({ data: [{ id: 'ch-line', code: 'line', config: {} }], error: null }),
      }),
    }),
  });
});

afterEach(() => {
  process.env = { ...OLD_ENV };
  vi.restoreAllMocks();
});

describe('/api/cron/line-sync 認可', () => {
  it('認証なしは 401 (送信本体を呼ばない)', async () => {
    const res = await GET(new NextRequest('http://localhost/api/cron/line-sync'));
    expect(res.status).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('Bearer CRON_SECRET で active line channel を送信委譲し 200', async () => {
    sendMock.mockResolvedValue({ channelId: 'ch-line', channelCode: 'line', attempted: 2, succeeded: 2, failed: 0, errors: [] });
    const req = new NextRequest('http://localhost/api/cron/line-sync', {
      headers: { authorization: 'Bearer test-cron-secret' },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.channels[0].outbound).toEqual({ attempted: 2, succeeded: 2, failed: 0 });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0]).toMatchObject({ id: 'ch-line', code: 'line' });
  });

  it('channel エラーは 207 (multi-status) で報告', async () => {
    sendMock.mockRejectedValue(new Error('boom'));
    const req = new NextRequest('http://localhost/api/cron/line-sync', {
      headers: { authorization: 'Bearer test-cron-secret' },
    });
    const res = await GET(req);
    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.channels[0].error).toContain('boom');
  });
});
