/**
 * runEmbedOneshotAndPoll (origin-ai embed oneshot 起動 + ポーリング) のテスト。
 *
 * 重点 (codex code review 反映):
 *  - 404 は **連続** >3 回でのみ not-found に倒す。途中で非404 (queued 等) が挟まれば
 *    カウンタはリセットされ、断続的な 404 で誤って embed_run_not_found を返さない。
 *  - 鍵未配布は embed_key_unprovisioned で fail-closed。
 *  - 正常系: POST 202 → completed result を写す。
 *
 * global.fetch をモック。poll 間隔は EMBED_RUN_POLL_INTERVAL_MS=1 で短縮。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  runEmbedOneshotAndPoll,
  DEFAULT_POLL_DEADLINE_MS,
  DEFAULT_POLL_INTERVAL_MS,
} from '@/lib/embed/run-oneshot';

const BASE = 'https://origin-ai.example.com';

function res(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

const ARGS = {
  slug: 'cs-reply:draft',
  targetType: 'customer_record',
  targetId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  input: { inquiry_text: 'いつ届きますか' },
};

let savedKey: string | undefined;
let savedBase: string | undefined;
let savedInterval: string | undefined;

beforeEach(() => {
  savedKey = process.env.EMBED_CLIENT_KEY;
  savedBase = process.env.ORIGIN_AI_BASE_URL;
  savedInterval = process.env.EMBED_RUN_POLL_INTERVAL_MS;
  process.env.EMBED_CLIENT_KEY = 'test-key';
  process.env.ORIGIN_AI_BASE_URL = BASE;
  process.env.EMBED_RUN_POLL_INTERVAL_MS = '1';
});

afterEach(() => {
  process.env.EMBED_CLIENT_KEY = savedKey;
  process.env.ORIGIN_AI_BASE_URL = savedBase;
  process.env.EMBED_RUN_POLL_INTERVAL_MS = savedInterval;
  vi.restoreAllMocks();
});

/** POST は常に 202 + run_id。GET poll は与えた配列を順に返す。 */
function mockFetchSequence(pollResponses: Response[]) {
  let pollIdx = 0;
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/api/embed/run')) return res(202, { run_id: 'run-1' });
    // /api/embed/runs/{id}
    const r = pollResponses[Math.min(pollIdx, pollResponses.length - 1)];
    pollIdx += 1;
    return r;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('runEmbedOneshotAndPoll', () => {
  it('正常系: POST 202 → completed の result を写す', async () => {
    mockFetchSequence([
      res(200, { status: 'queued' }),
      res(200, { status: 'running' }),
      res(200, { status: 'completed', result: { reply_draft: 'ok', needs_escalation: false } }),
    ]);
    const out = await runEmbedOneshotAndPoll(ARGS);
    expect(out.ok).toBe(true);
    expect(out.result?.reply_draft).toBe('ok');
  });

  it('断続的な 404 (非404 が挟まる) では not-found に倒さず完了する', async () => {
    // 404, queued(reset), 404, 404, 404(=連続3), completed。
    // 累積カウントなら 4 回目の 404 で not-found になるが、連続判定では完了するのが正。
    mockFetchSequence([
      res(404, {}),
      res(200, { status: 'queued' }),
      res(404, {}),
      res(404, {}),
      res(404, {}),
      res(200, { status: 'completed', result: { reply_draft: 'ok', needs_escalation: false } }),
    ]);
    const out = await runEmbedOneshotAndPoll(ARGS);
    expect(out.ok).toBe(true);
    expect(out.result?.reply_draft).toBe('ok');
  });

  it('連続 4 回の 404 は embed_run_not_found で fail-closed', async () => {
    mockFetchSequence([res(404, {}), res(404, {}), res(404, {}), res(404, {})]);
    const out = await runEmbedOneshotAndPoll(ARGS);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('embed_run_not_found');
  });

  it('鍵未配布は embed_key_unprovisioned で fail-closed (fetch を呼ばない)', async () => {
    delete process.env.EMBED_CLIENT_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const out = await runEmbedOneshotAndPoll(ARGS);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('embed_key_unprovisioned');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('failed ステータスは embed_run_failed で返す', async () => {
    mockFetchSequence([res(200, { status: 'running' }), res(200, { status: 'failed' })]);
    const out = await runEmbedOneshotAndPoll(ARGS);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('embed_run_failed');
  });
});

describe('runEmbedOneshotAndPoll: deadline/interval オプション (additive・既定不変)', () => {
  it('既定の poll deadline/interval は 150s/2s のまま変わらない', () => {
    expect(DEFAULT_POLL_DEADLINE_MS).toBe(150_000);
    expect(DEFAULT_POLL_INTERVAL_MS).toBe(2_000);
  });

  it('deadlineMs を短く指定すると、その締切で poll deadline に倒れる (呼出側オプションが効く)', async () => {
    // 常に running を返し続ける fetch (=既定 150s ならまず終わらない) に対し、
    // deadlineMs=5ms を指定すると短い締切で embed_run_poll_deadline に倒れることを確認する。
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/embed/run')) return res(202, { run_id: 'run-1' });
      return res(200, { status: 'running' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await runEmbedOneshotAndPoll({ ...ARGS, deadlineMs: 5, intervalMs: 1 });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('embed_run_poll_deadline');
  });

  it('intervalMs 省略時は EMBED_RUN_POLL_INTERVAL_MS (既存のテスト短縮手段) が従来どおり効く', async () => {
    // ARGS に intervalMs を渡さない呼出は、既存の env 短縮 (beforeEach で 1ms 設定済) が
    // そのまま有効であること (回帰確認)。
    mockFetchSequence([
      res(200, { status: 'queued' }),
      res(200, { status: 'completed', result: { reply_draft: 'ok', needs_escalation: false } }),
    ]);
    const out = await runEmbedOneshotAndPoll(ARGS);
    expect(out.ok).toBe(true);
  });
});
