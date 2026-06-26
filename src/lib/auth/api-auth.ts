import { NextRequest, NextResponse } from 'next/server';
import { createHash, timingSafeEqual } from 'node:crypto';
import { getInboundVerifyKeys } from '@/lib/credentials';

export type AuthTier = 'cron' | 'diag';

/**
 * /api/* ルート共通の認可ヘルパ (cron / diag tier)。
 *
 * tier='cron': `Authorization: Bearer <CRON_SECRET>` または `X-Diag-Token: <DIAG_TOKEN>` のいずれか。
 *   Vercel Cron は前者を自動付与、手動デバッグは後者を使う運用。
 *
 * tier='diag': `X-Diag-Token: <DIAG_TOKEN>` のみ。`Authorization: Bearer ...` は明示的に許可しない。
 *
 * tier='internal' は **接続鍵 Core 集約 Done-1** で `authorizeInternalApiRoute()` (async・Core
 * core_internal_shared 経由) に分離した。本関数は Core 非依存の cron/diag のみを sync で扱う
 * (cron を Core 障害に巻き込まないため)。
 *
 * - env 未設定 → 500 (レスポンス本文に env 変数名は出さない)
 * - 認証失敗 → 401 (ヒント文言なし)
 * - すべて timing-safe 比較
 */
export function authorizeApiRoute(
  req: NextRequest,
  opts: { tier: AuthTier },
): NextResponse | null {
  switch (opts.tier) {
    case 'cron':
      return checkCron(req);
    case 'diag':
      return checkDiag(req);
  }
}

/**
 * tier='internal' の認可 (接続鍵 Core 集約 Done-1)。
 *
 * 旧実装は `X-Internal-API-Key === process.env.INTERNAL_API_KEY` の env 比較だったが、
 * Done-1 で全ツール共通の正本内部鍵 (Core service_code='core_internal_shared') 取得値のみで
 * 照合するように切替えた。期待値は `getInboundVerifyKeys()` (Core 経由・stale-while-error 付き)。
 *
 * これは「API ルートの内部化」(ブラウザ直叩き遮断) であり、ユーザー認証ではない。
 * 本ツール自身の Server Action が internalFetch で送る X-Internal-API-Key (= 同 core_internal_shared)
 * と、origin-core が送る同値の両方を受理する (今日の global 鍵と同一 trust boundary・regression 無し)。
 *
 * fail-closed:
 *   - ヘッダ非 string / 空 → Core 取得前に即 401 (未認証 probe で Core を叩かない。codex 必須#1)。
 *   - 期待値候補が一つも無い (Core 未到達かつ stale 失効) → 500 (env 変数名は出さない)。
 *   - 候補は短絡せず sha256 固定長 digest で timing-safe 全件比較 (長さ漏洩を避ける)。不一致 → 401。
 *
 * node:crypto を使うため呼出ルートは runtime='nodejs' であること (既存全ルート該当)。
 * 設計レビュー: codex APPROVE (2026-06-26)。
 */
export async function authorizeInternalApiRoute(
  req: NextRequest,
): Promise<NextResponse | null> {
  const provided = trimRight(req.headers.get('x-internal-api-key') ?? undefined);
  // 空/欠落ヘッダは Core lookup 前に即 401 (DoS 耐性: どの候補とも一致し得ない)。
  if (!provided) return unauthorized();

  const keys = await getInboundVerifyKeys();
  if (keys.length === 0) return serverMisconfigured();

  // 候補を短絡せず全件 timing-safe 比較 (一致候補のタイミング差を作らない)。
  const providedDigest = sha256(provided);
  let matched = false;
  for (const expected of keys) {
    if (typeof expected !== 'string' || expected.length === 0) continue;
    if (timingSafeEqual(providedDigest, sha256(expected))) matched = true;
  }
  return matched ? null : unauthorized();
}

function checkCron(req: NextRequest): NextResponse | null {
  const cronSecret = trimRight(process.env.CRON_SECRET);
  const diagToken = trimRight(process.env.DIAG_TOKEN);
  if (!cronSecret && !diagToken) return serverMisconfigured();

  const authHeader = req.headers.get('authorization') ?? '';
  if (cronSecret && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice('Bearer '.length);
    if (constantTimeEqual(token, cronSecret)) return null;
  }

  if (diagToken) {
    const provided = req.headers.get('x-diag-token') ?? '';
    if (constantTimeEqual(provided, diagToken)) return null;
  }

  return unauthorized();
}

function checkDiag(req: NextRequest): NextResponse | null {
  const diagToken = trimRight(process.env.DIAG_TOKEN);
  if (!diagToken) return serverMisconfigured();
  const provided = req.headers.get('x-diag-token') ?? '';
  return constantTimeEqual(provided, diagToken) ? null : unauthorized();
}

function unauthorized(): NextResponse {
  return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
}

function serverMisconfigured(): NextResponse {
  return NextResponse.json({ ok: false, error: 'Server misconfigured' }, { status: 500 });
}

function trimRight(v: string | undefined): string | undefined {
  return v?.replace(/\s+$/, '');
}

/** 固定長 (32 byte) sha256 digest。長さ漏洩なしで timingSafeEqual に渡せる。 */
function sha256(input: string): Buffer {
  return createHash('sha256').update(input, 'utf8').digest();
}

function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) {
    const dummy = Buffer.alloc(aBuf.length || 1);
    timingSafeEqual(dummy, dummy);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}
