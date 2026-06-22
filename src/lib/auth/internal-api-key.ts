import { NextRequest, NextResponse } from 'next/server';
import { authorizeApiRoute } from './api-auth';

/**
 * 内部 API ルートの認可 (後方互換ラッパ)。
 *
 * 実装は `authorizeApiRoute(req, { tier: 'internal' })` に委譲。
 * 既存呼び出し元 (例: /api/tickets/[id]/draft-rag) との互換のために残す。
 */
export function authorizeInternalApiKey(req: NextRequest): NextResponse | null {
  return authorizeApiRoute(req, { tier: 'internal' });
}
