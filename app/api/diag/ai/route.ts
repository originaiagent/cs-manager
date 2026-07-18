import { NextRequest, NextResponse } from 'next/server';
import { invokeChat } from '@/lib/ai-client';
import { authorizeApiRoute } from '@/lib/auth/api-auth';
import {
  classifyViaEmbed,
  DEFECT_CLASSIFY_EMBED_SLUG,
  RETURN_COMMENT_CLASSIFY_EMBED_SLUG,
} from '@/lib/quality/classify-embed';

export const dynamic = 'force-dynamic';

interface DiscoveryWorkDto {
  kind?: unknown;
  slug?: unknown;
}

/**
 * origin-ai /api/embed/discovery を認証付きで叩き、分類2 oneshot (kind='oneshot') の両 slug が
 * embed client から可視かを確認する。HTTP 200 でも対象 slug が不足していれば ok:false にする
 * (契約破壊を「疎通OK」に丸めない。分類2cronの embed 経路移行に伴う診断口の追随)。
 */
async function checkClassifyEmbedDiscovery(): Promise<{
  ok: boolean;
  error?: string;
  visibleSlugs?: string[];
}> {
  const key = process.env.EMBED_CLIENT_KEY?.replace(/\s+$/, '');
  const baseUrl = process.env.ORIGIN_AI_BASE_URL?.replace(/\s+$/, '').replace(/\/$/, '');
  if (!key || !baseUrl) {
    return { ok: false, error: 'embed_key_unprovisioned' };
  }

  let resp: Response;
  try {
    resp = await fetch(`${baseUrl}/api/embed/discovery`, {
      headers: { 'X-Embed-Key': key },
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, error: 'discovery_request_failed' };
  }
  if (!resp.ok) {
    // 401/403 (embed 鍵未認可) 等も含めここで ok:false (raw body は返さない)。
    return { ok: false, error: `discovery_${resp.status}` };
  }

  let json: { works?: DiscoveryWorkDto[] };
  try {
    json = (await resp.json()) as { works?: DiscoveryWorkDto[] };
  } catch {
    return { ok: false, error: 'discovery_invalid_json' };
  }

  const works = Array.isArray(json.works) ? json.works : [];
  const visibleOneshotSlugs = new Set(
    works
      .filter((w) => w.kind === 'oneshot' && typeof w.slug === 'string')
      .map((w) => w.slug as string),
  );
  const required = [DEFECT_CLASSIFY_EMBED_SLUG, RETURN_COMMENT_CLASSIFY_EMBED_SLUG];
  const missing = required.filter((slug) => !visibleOneshotSlugs.has(slug));
  if (missing.length > 0) {
    return { ok: false, error: `discovery_slug_missing:${missing.join(',')}` };
  }
  return { ok: true, visibleSlugs: Array.from(visibleOneshotSlugs) };
}

export async function GET(req: NextRequest) {
  const authError = authorizeApiRoute(req, { tier: 'diag' });
  if (authError) return authError;

  try {
    // CLASSIFY_VIA_EMBED=true (既定): 分類2 oneshot が embed 経路から可視かを確認する。
    // false (ロールバック中): 現行 invokeChat ping のまま (接続確認の意味は不変)。
    if (classifyViaEmbed()) {
      const result = await checkClassifyEmbedDiscovery();
      return NextResponse.json(result);
    }
    const result = await invokeChat('ping from cs-manager diag');
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error?.message ?? String(error) }, { status: 500 });
  }
}
