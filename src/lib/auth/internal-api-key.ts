import { NextRequest, NextResponse } from 'next/server';
import { authorizeInternalApiRoute } from './api-auth';

/**
 * 内部 API ルートの認可 (後方互換ラッパ)。
 *
 * 実装は `authorizeInternalApiRoute(req)` に委譲 (接続鍵 Core 集約 Done-1 で async 化:
 * 期待値を Core core_internal_shared から取得するため)。
 * 既存呼び出し元 (例: /api/tickets/[id]/draft-rag) との互換のために残す。
 */
export function authorizeInternalApiKey(
  req: NextRequest,
): Promise<NextResponse | null> {
  return authorizeInternalApiRoute(req);
}
