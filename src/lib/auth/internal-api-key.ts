import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';

/**
 * 内部 API ルートの認可。
 *
 * X-Internal-API-Key ヘッダが process.env.INTERNAL_API_KEY と一致した場合のみ通す。
 * 一致しなければ 401 を即返却。INTERNAL_API_KEY 自体が未設定なら 500。
 *
 * クライアント (ブラウザ) からは絶対に呼ばないこと。
 * Server Component / Server Action から呼ぶ前提のルートに付与する。
 *
 * timingSafeEqual を使い、ヘッダ値長によるタイミング差を抑える。
 */
export function authorizeInternalApiKey(req: NextRequest): NextResponse | null {
  const expected = process.env.INTERNAL_API_KEY?.replace(/\s+$/, '');
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: 'INTERNAL_API_KEY is not set on server' },
      { status: 500 },
    );
  }

  const provided = req.headers.get('x-internal-api-key') ?? '';
  if (!constantTimeEqual(provided, expected)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) {
    // 長さが異なると timingSafeEqual が throw する。ダミー比較で時間を揃えて false 返却。
    const dummy = Buffer.alloc(aBuf.length || 1);
    timingSafeEqual(dummy, dummy);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}
