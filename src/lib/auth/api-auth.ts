import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';

export type AuthTier = 'internal' | 'cron' | 'diag';

/**
 * 全 /api/* ルート共通の認可ヘルパ。
 *
 * tier='internal': X-Internal-API-Key === process.env.INTERNAL_API_KEY のみ通す。
 *   ブラウザ UI は Server Action 経由 (server-only env 注入) でのみ通る。
 *   ※ これは「API ルートの内部化」であり、ユーザー認証ではない。
 *   ※ UI 到達者へのユーザー認証は Phase 1.2 で別途対応する。
 *
 * tier='cron': `Authorization: Bearer <CRON_SECRET>` または `X-Diag-Token: <DIAG_TOKEN>` のいずれか。
 *   Vercel Cron は前者を自動付与、手動デバッグは後者を使う運用。
 *
 * tier='diag': `X-Diag-Token: <DIAG_TOKEN>` のみ。`Authorization: Bearer ...` は明示的に許可しない。
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
    case 'internal':
      return checkInternal(req);
    case 'cron':
      return checkCron(req);
    case 'diag':
      return checkDiag(req);
  }
}

function checkInternal(req: NextRequest): NextResponse | null {
  const expected = trimRight(process.env.INTERNAL_API_KEY);
  if (!expected) return serverMisconfigured();
  const provided = req.headers.get('x-internal-api-key') ?? '';
  return constantTimeEqual(provided, expected) ? null : unauthorized();
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
