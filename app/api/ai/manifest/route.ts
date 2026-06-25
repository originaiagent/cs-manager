/**
 * GET /api/ai/manifest — cs-manager の AI 能力マニフェスト (business-concept 粒度)。
 *
 * backlog 20a408eb「全ツール AI 能力カタログ」Stage2 ファンアウト。参照実装: ec-manager。
 * origin-core が内部鍵で集約し、メタエージェントがユーザー語→ツール概念を意味照合する。
 *
 * 認証: X-Internal-API-Key (全ツール共有の内部鍵)。authorizeAiManifestRequest が
 *       timing-safe に検証する (INTERNAL_API_KEY + INTERNAL_API_KEY_NEW)。
 * 性質: read 専用・副作用なし・純メタデータのみ (additive / dark)。
 *
 * middleware (OIDC user-auth) は /api/* を全除外 (PUBLIC_PATHS=['/login','/api']) し、
 * かつ既定で flag OFF のため、本ルートは user-login wall の外で内部鍵だけで到達可能。
 */

import { type NextRequest, NextResponse } from 'next/server';
import { manifest } from '@/lib/ai-capabilities/manifest';
import { authorizeAiManifestRequest } from '@/lib/ai-capabilities/internal-key-guard';

// node:crypto を使う内部鍵ガードのため Node runtime を強制する。
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authError = await authorizeAiManifestRequest(req);
  if (authError) return authError;

  return NextResponse.json(manifest, { status: 200 });
}
