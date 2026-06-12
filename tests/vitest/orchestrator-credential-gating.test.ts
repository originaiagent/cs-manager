/**
 * 「キーを Core に入れるだけで受信開始 (コード変更ゼロ)」の核心ロジック実証テスト
 *
 * orchestrator の resolvePullCredentials は pull チャネルの稼働可否を Core の credential
 * 有無だけで決める:
 *   - キー未投入 (Core 404) → skip (error にしない)。次 tick でキーがあれば自動的に ok。
 *   - キー投入後 → ok (credentials を adapter に注入)。
 * 同じ channel 行・同じコードのまま、Core 応答が 404→200 に変わるだけで skip→稼働に
 * 切り替わることを、Core を注入で差し替えて実証する。
 */
import { describe, it, expect, vi } from 'vitest';
import { resolvePullCredentials } from '@/lib/sync/orchestrator';
import { CredentialFetchError, type CredentialResponse } from '@/lib/credentials';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

const yahooChannel = {
  id: 'ch-yahoo',
  code: 'yahoo',
  config: { ingestion: 'pull', service_code: 'yahoo_shopping', scope_key_field: 'store_id', store_id: 'store-123' },
};

function okResponse(creds: Record<string, unknown>): CredentialResponse {
  return {
    service_code: 'yahoo_shopping', scope_key: 'store-123', credentials: creds,
    metadata: {}, valid_from: new Date(0).toISOString(), valid_to: null,
  };
}

describe('resolvePullCredentials — キー投入だけで skip→稼働', () => {
  it('キー未投入 (Core 404) → skip (error にしない)', async () => {
    const getCred = vi.fn(async () => { throw new CredentialFetchError('not found', 404, 'yahoo_shopping', 'store-123'); });
    const r = await resolvePullCredentials(yahooChannel, noopLogger, getCred as any);
    expect(r.kind).toBe('skip');
    // scope_key_field='store_id' の値で Core を引いている
    expect(getCred).toHaveBeenCalledWith('yahoo_shopping', 'store-123');
  });

  it('キー投入後 (Core 200) → ok + credentials 注入 (コード変更ゼロで稼働)', async () => {
    const getCred = vi.fn(async () => okResponse({ access_token: 'tok-abc' }));
    const r = await resolvePullCredentials(yahooChannel, noopLogger, getCred as any);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.credentials.access_token).toBe('tok-abc');
  });

  it('service_code 未宣言 → misconfig error', async () => {
    const ch = { id: 'x', code: 'yahoo', config: { ingestion: 'pull' } };
    const getCred = vi.fn();
    const r = await resolvePullCredentials(ch, noopLogger, getCred as any);
    expect(r.kind).toBe('error');
    expect(getCred).not.toHaveBeenCalled();
  });

  it('allowlist 外の service_code → error (Core を引かない=鍵窃取防御)', async () => {
    const ch = { id: 'x', code: 'yahoo', config: { ingestion: 'pull', service_code: 'supabase_service_role' } };
    const getCred = vi.fn();
    const r = await resolvePullCredentials(ch, noopLogger, getCred as any);
    expect(r.kind).toBe('error');
    expect(getCred).not.toHaveBeenCalled();
  });

  it('Core 500 等 (404以外) → error (再試行対象、skip にしない)', async () => {
    const getCred = vi.fn(async () => { throw new CredentialFetchError('server error', 500, 'yahoo_shopping', 'store-123'); });
    const r = await resolvePullCredentials(yahooChannel, noopLogger, getCred as any);
    expect(r.kind).toBe('error');
  });
});
