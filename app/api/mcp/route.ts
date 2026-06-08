/**
 * POST /api/mcp — embed MCP read-only 窓口 (streamable-HTTP / JSON-RPC 2.0)
 *
 * これは tool-template の「read-only 窓口」雛形である (embed 波及 Phase A/C)。
 * 正本は minpaku-tool/src/mcp。各ツールは:
 *   1. lib/mcp/manifest.ts を自ツールの forms/places (DB列名に1:1) で埋める。
 *   2. lib/mcp/service.ts を自ツールの service/API 層 wrapper として実装 (read のみで可)。
 *   3. write を有効化する時のみ handleWrite を実装し contract test green 後に gate を開ける。
 *
 * read-only 段階の方針 (codex APPROVE 2026-06-08 / docs embed-propagation-design §1):
 *   - initialize / tools/list : 認証不要 (匿名 200)。Done条件1 の計測対象。
 *   - tools/call (list/read/fetch-file) : run-scoped JWT 必須 (fail-closed)。匿名では叩けない。
 *   - tools/call (write/place-file)     : read-only 段階では一律 disabled を返す (fail-closed)。
 *
 * このルートは middleware の user-auth を免除する (/api/mcp を matcher から除外すること)。
 */

import { type NextRequest, NextResponse } from 'next/server';
import { manifest } from '@/lib/mcp/manifest';
import { authenticateMcpRequest } from '@/lib/mcp/auth';
import { handleList } from '@/lib/mcp/capabilities/list';
import { handleRead } from '@/lib/mcp/capabilities/read';
// fetch-file を提供するツールのみ有効化:
// import { handleFetchFile } from '@/lib/mcp/capabilities/fetch-file';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// JSON-RPC 2.0
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: unknown;
}

function rpcOk(id: string | number | null, result: unknown): NextResponse {
  return NextResponse.json({ jsonrpc: '2.0', id, result }, { status: 200 });
}

function rpcErr(
  id: string | number | null,
  code: number,
  message: string,
  status = 200,
): NextResponse {
  return NextResponse.json({ jsonrpc: '2.0', id, error: { code, message } }, { status });
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const AUTH_ERROR = -32001;

// ---------------------------------------------------------------------------
// ツール定義 (read-only 段階: list / read / fetch-file)。
// write / place-file は write 有効化時に追加する。
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'list',
    description: '読取可能箇所の一覧を返す',
    inputSchema: {
      type: 'object',
      properties: { form_id: { type: 'string' } },
      required: ['form_id'],
    },
  },
  {
    name: 'read',
    description: '箇所の現在値と revision (etag) を返す',
    inputSchema: {
      type: 'object',
      properties: {
        form_id: { type: 'string' },
        place_id: { type: 'string' },
        index: { type: 'number' },
      },
      required: ['form_id', 'place_id'],
    },
  },
  // fetch-file を提供するツールはここに 'fetch-file' を追加する。
];

// read-only 窓口が拒否する write 系 op (fail-closed)。
const WRITE_OPS = new Set(['write', 'place-file']);
const READ_OPS: Record<string, string> = { list: 'list', read: 'read', 'fetch-file': 'fetch-file' };

// ---------------------------------------------------------------------------
// ハンドラ
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  let rpc: JsonRpcRequest;
  try {
    const raw = await req.json();
    if (!raw || typeof raw !== 'object' || raw.jsonrpc !== '2.0' || typeof raw.method !== 'string') {
      return rpcErr(null, INVALID_REQUEST, 'Invalid Request');
    }
    rpc = raw as JsonRpcRequest;
  } catch {
    return rpcErr(null, PARSE_ERROR, 'Parse error', 400);
  }

  const { id, method, params } = rpc;

  if (method.startsWith('notifications/')) {
    return new NextResponse(null, { status: 202 });
  }

  // initialize — 匿名許可 (debug metadata / env URL / stack を返さない)
  if (method === 'initialize') {
    return rpcOk(id, {
      protocolVersion: '2024-11-05',
      serverInfo: {
        name: process.env.MCP_SERVER_NAME ?? manifest.tool_slug,
        version: manifest.schema_version,
      },
      capabilities: { tools: {} },
    });
  }

  // tools/list — 匿名許可
  if (method === 'tools/list') {
    return rpcOk(id, { tools: TOOLS });
  }

  // tools/call — run-scoped JWT 必須
  if (method === 'tools/call') {
    const p = params as Record<string, unknown> | undefined;
    const toolName = p?.name as string | undefined;
    const toolArgs = (p?.arguments ?? {}) as Record<string, unknown>;
    if (!toolName) return rpcErr(id, INVALID_PARAMS, 'tools/call requires params.name');

    // read-only 窓口: write 系は一律 disabled (fail-closed)
    if (WRITE_OPS.has(toolName)) {
      return rpcOk(id, {
        ok: false,
        reason: 'write disabled (read-only window). contract test green 後に gate を開けること。',
      });
    }
    if (!READ_OPS[toolName]) {
      return rpcErr(id, METHOD_NOT_FOUND, `Unknown tool: ${toolName}`);
    }

    const form_id = (toolArgs.form_id as string) ?? '';
    const authHeader = req.headers.get('authorization');

    // JWT payload を事前抽出 (target は claim 由来・args 不可 = IDOR 防止)
    let targetType = '';
    let targetId = '';
    let sessionId = '';
    let agentId = '';
    try {
      const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
      if (token) {
        const parts = token.split('.');
        if (parts.length === 3) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
          targetType = payload.target_type ?? '';
          targetId = payload.target_id ?? '';
          sessionId = payload.session_id ?? '';
          agentId = payload.agent_id ?? '';
        }
      }
    } catch {
      /* 認証ステップで適切に拒否される */
    }

    const placeId = (toolArgs.place_id as string) ?? undefined;
    const authResult = await authenticateMcpRequest(authHeader, {
      op: READ_OPS[toolName],
      form_id,
      place_id: placeId,
      target_type: targetType,
      target_id: targetId,
      session_id: sessionId || undefined,
      agent_id: agentId || undefined,
    });
    if (!authResult.ok) return rpcErr(id, AUTH_ERROR, authResult.err.message, authResult.err.status);

    const { claims } = authResult.ctx;
    const resolvedTargetId = claims.target_id;

    // form_id を JWT target_type に束縛 (cross-form 攻撃防止)
    if (form_id) {
      const formDef = manifest.forms.find((f) => f.form_id === form_id);
      if (!formDef) return rpcErr(id, INVALID_PARAMS, `form_id "${form_id}" は manifest に未定義`, 400);
      if (formDef.target_type !== claims.target_type) {
        return rpcErr(id, AUTH_ERROR, `form_id の target_type がトークンと不一致`, 403);
      }
    }

    try {
      switch (toolName) {
        case 'list': {
          const result = handleList({ form_id });
          if (!result.ok) return rpcErr(id, INVALID_PARAMS, result.message);
          return rpcOk(id, result.data);
        }
        case 'read': {
          const result = await handleRead(
            { form_id, place_id: toolArgs.place_id as string, index: toolArgs.index as number | undefined },
            resolvedTargetId,
          );
          if (!result.ok) return rpcErr(id, INVALID_PARAMS, result.message);
          return rpcOk(id, result.data);
        }
        // fetch-file を提供するツールは handleFetchFile を追加する。
        default:
          return rpcErr(id, METHOD_NOT_FOUND, `Unknown tool: ${toolName}`);
      }
    } catch (err) {
      console.error('[api/mcp] tools/call 内部エラー:', (err as Error)?.message ?? err);
      return rpcErr(id, INTERNAL_ERROR, '内部エラーが発生しました');
    }
  }

  return rpcErr(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
}

// GET は 405 (MCP は POST only)
export function GET(): NextResponse {
  return NextResponse.json({ ok: false, error: 'Method Not Allowed. Use POST for MCP.' }, { status: 405 });
}
