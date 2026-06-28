import { NextRequest, NextResponse } from 'next/server';
import { authorizeApiRoute } from '@/lib/auth/api-auth';
import { createYahooProxiedFetch } from '@/channels/yahoo/egress';

/**
 * 診断: cs-manager → 固定IPプロキシ → Yahoo の経路が通っているかを本番で再現確認する。
 *
 * 認可: tier='diag' (X-Diag-Token: $DIAG_TOKEN)。
 * 動作: Yahoo の公開ホストへ proxy 経由で実リクエストし、Yahoo から応答 (任意のステータス) が
 *       返れば「cs-manager の Yahoo 呼び出しがプロキシ経由で疎通している」ことの証跡になる。
 *       proxy 解決失敗時は fail-closed で 502 (直 fetch しない)。proxy の値・creds は出さない。
 *
 * undici ProxyAgent を使うため Node ランタイム必須。
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const YAHOO_PROBE_URL = 'https://circus.shopping.yahooapis.jp/';
const PROBE_TIMEOUT_MS = 15_000;

export async function GET(req: NextRequest) {
  const authError = authorizeApiRoute(req, { tier: 'diag' });
  if (authError) return authError;

  try {
    const proxiedFetch = createYahooProxiedFetch();
    const res = await proxiedFetch(YAHOO_PROBE_URL, {
      method: 'GET',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // 任意ステータス (404 等含む) で「proxy 経由で Yahoo に到達した」= 経路 OK。
    return NextResponse.json({
      ok: true,
      viaProxy: true,
      probe: 'circus.shopping.yahooapis.jp',
      yahooStatus: res.status,
    });
  } catch (err: any) {
    // proxy 未配線/到達不能/credential 不在は fail-closed。値は反射しない (name のみ)。
    return NextResponse.json(
      { ok: false, viaProxy: true, error: err?.name ?? 'error' },
      { status: 502 },
    );
  }
}
