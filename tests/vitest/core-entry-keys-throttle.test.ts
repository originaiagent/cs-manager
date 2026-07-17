/**
 * fetchWithEntryKeys の流量制御 (src/lib/core-entry-keys.ts) の単体テスト。
 *
 * 不良数が全製品 0 になる事故は「Core への無制限並列 → 429 → 解決がランダムに全滅」が原因。
 * ここでは防御側 (同時実行セマフォ / 429・503 バックオフ再試行 / Retry-After 尊重) を固定する。
 *
 * セマフォ状態はモジュールスコープのため各テストで vi.resetModules() する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const OLD_ENV = { ...process.env };
const URL_UNDER_TEST = 'https://core.example.test/api/v1/master/products?limit=1';
const KEYS = ['test-entry-key'];

beforeEach(() => {
  vi.resetModules();
  process.env.CORE_CREDENTIAL_KEY = 'test-entry-key';
  delete process.env.CORE_MAX_CONCURRENCY;
});

afterEach(() => {
  process.env = { ...OLD_ENV };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchWithEntryKeys — 同時実行セマフォ', () => {
  it('同時実行が CORE_MAX_CONCURRENCY を超えない', async () => {
    process.env.CORE_MAX_CONCURRENCY = '3';
    let inFlight = 0;
    let peak = 0;
    const fetchMock = vi.fn(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return new Response('{}', { status: 200 });
    });

    const { fetchWithEntryKeys } = await import('@/lib/core-entry-keys');
    await Promise.all(
      Array.from({ length: 30 }, () =>
        fetchWithEntryKeys(URL_UNDER_TEST, { method: 'GET' }, { fetchImpl: fetchMock, entryKeys: KEYS }),
      ),
    );

    expect(peak).toBeLessThanOrEqual(3);
    expect(fetchMock).toHaveBeenCalledTimes(30); // 全件は投げ切る (間引きではない)
  });

  it('既定の同時実行上限は 6', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchMock = vi.fn(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return new Response('{}', { status: 200 });
    });

    const { fetchWithEntryKeys } = await import('@/lib/core-entry-keys');
    await Promise.all(
      Array.from({ length: 40 }, () =>
        fetchWithEntryKeys(URL_UNDER_TEST, { method: 'GET' }, { fetchImpl: fetchMock, entryKeys: KEYS }),
      ),
    );

    expect(peak).toBeLessThanOrEqual(6);
    expect(peak).toBeGreaterThan(1); // 直列化はしていない
  });
});

describe('fetchWithEntryKeys — 429/503 バックオフ再試行', () => {
  it('429 が続く場合は最大 2 回再試行し (計 3 リクエスト) 最後の response を返す', async () => {
    const fetchMock = vi.fn(async () => new Response('busy', { status: 429 }));
    const { fetchWithEntryKeys } = await import('@/lib/core-entry-keys');

    const res = await fetchWithEntryKeys(
      URL_UNDER_TEST,
      { method: 'GET' },
      { fetchImpl: fetchMock, entryKeys: KEYS },
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(res.status).toBe(429);
  });

  it('429 の後に成功したらその結果を返す (再試行は打ち切る)', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      return calls === 1
        ? new Response('busy', { status: 429 })
        : new Response(JSON.stringify({ data: 'ok' }), { status: 200 });
    });
    const { fetchWithEntryKeys } = await import('@/lib/core-entry-keys');

    const res = await fetchWithEntryKeys(
      URL_UNDER_TEST,
      { method: 'GET' },
      { fetchImpl: fetchMock, entryKeys: KEYS },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: 'ok' });
  });

  it('503 も再試行対象', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      return calls === 1 ? new Response('down', { status: 503 }) : new Response('{}', { status: 200 });
    });
    const { fetchWithEntryKeys } = await import('@/lib/core-entry-keys');

    const res = await fetchWithEntryKeys(
      URL_UNDER_TEST,
      { method: 'GET' },
      { fetchImpl: fetchMock, entryKeys: KEYS },
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
  });

  it('Retry-After (秒) を待機時間として尊重する', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      return calls === 1
        ? new Response('busy', { status: 429, headers: { 'Retry-After': '1' } })
        : new Response('{}', { status: 200 });
    });
    const { fetchWithEntryKeys } = await import('@/lib/core-entry-keys');

    const started = Date.now();
    const res = await fetchWithEntryKeys(
      URL_UNDER_TEST,
      { method: 'GET' },
      { fetchImpl: fetchMock, entryKeys: KEYS },
    );
    const elapsed = Date.now() - started;

    expect(res.status).toBe(200);
    // 基準待機 (300ms + jitter) ではなく Retry-After の 1 秒を待つ
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(3000);
  }, 10_000);

  it('429/503 以外の非 2xx は再試行しない (即返し)', async () => {
    const fetchMock = vi.fn(async () => new Response('bad', { status: 400 }));
    const { fetchWithEntryKeys } = await import('@/lib/core-entry-keys');

    const res = await fetchWithEntryKeys(
      URL_UNDER_TEST,
      { method: 'GET' },
      { fetchImpl: fetchMock, entryKeys: KEYS },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(400);
  });

  it('network エラーは再試行せず即 throw (鍵/待機で解決しない)', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('ECONNRESET'); });
    const { fetchWithEntryKeys } = await import('@/lib/core-entry-keys');

    await expect(
      fetchWithEntryKeys(URL_UNDER_TEST, { method: 'GET' }, { fetchImpl: fetchMock, entryKeys: KEYS }),
    ).rejects.toThrow(/ECONNRESET/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('再試行の待機中もセマフォ枠を占有しない (他リクエストが進める)', async () => {
    process.env.CORE_MAX_CONCURRENCY = '1';
    const order: string[] = [];
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const tag = new URL(String(url)).searchParams.get('tag') ?? '?';
      order.push(tag);
      // 最初の 429 リクエストだけ 1 回失敗させる
      if (tag === 'retry' && !order.includes('other')) {
        return new Response('busy', { status: 429 });
      }
      return new Response('{}', { status: 200 });
    });
    const { fetchWithEntryKeys } = await import('@/lib/core-entry-keys');

    const base = 'https://core.example.test/api/v1/master/products';
    await Promise.all([
      fetchWithEntryKeys(`${base}?tag=retry`, { method: 'GET' }, { fetchImpl: fetchMock, entryKeys: KEYS }),
      fetchWithEntryKeys(`${base}?tag=other`, { method: 'GET' }, { fetchImpl: fetchMock, entryKeys: KEYS }),
    ]);

    // retry の待機中に other が実行できている = 枠を握ったまま眠っていない
    expect(order).toEqual(['retry', 'other', 'retry']);
  });
});

describe('withCoreRequestCount — 診断用カウンタ', () => {
  it('実際に送出した Core リクエスト数を数える (再試行も 1 回として計上)', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      return calls === 1 ? new Response('busy', { status: 429 }) : new Response('{}', { status: 200 });
    });
    const { fetchWithEntryKeys, withCoreRequestCount } = await import('@/lib/core-entry-keys');

    const { result, coreRequests } = await withCoreRequestCount(async () => {
      await fetchWithEntryKeys(URL_UNDER_TEST, { method: 'GET' }, { fetchImpl: fetchMock, entryKeys: KEYS });
      await fetchWithEntryKeys(URL_UNDER_TEST, { method: 'GET' }, { fetchImpl: fetchMock, entryKeys: KEYS });
      return 'done';
    });

    expect(result).toBe('done');
    expect(coreRequests).toBe(3); // 429 + 再試行 + 2 本目
  });

  it('計測スコープ外の呼び出しは数えない', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    const { fetchWithEntryKeys, withCoreRequestCount } = await import('@/lib/core-entry-keys');

    await fetchWithEntryKeys(URL_UNDER_TEST, { method: 'GET' }, { fetchImpl: fetchMock, entryKeys: KEYS });
    const { coreRequests } = await withCoreRequestCount(async () => {
      await fetchWithEntryKeys(URL_UNDER_TEST, { method: 'GET' }, { fetchImpl: fetchMock, entryKeys: KEYS });
    });

    expect(coreRequests).toBe(1);
  });
});
