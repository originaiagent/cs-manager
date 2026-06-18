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
import { handleWrite, type WriteOp } from '@/lib/mcp/capabilities/write';
import { handleReversibleWrite } from '@/lib/mcp/reversibility';
import { isFormWriteEnabled } from '@/lib/mcp/service';
// fetch-file を提供するツールのみ有効化:
// import { handleFetchFile } from '@/lib/mcp/capabilities/fetch-file';

// 書き込み可逆性レイヤー (v4) の有効化フラグ。正本: minpaku-tool route.ts。
// OFF (既定): handshake を一切行わず現行 legacy write を実行する (現挙動完全維持)。
// ON: write op のみ intent→validate→apply→audit の handshake を行う。
function isReversibilityEnabled(): boolean {
  return process.env.EMBED_REVERSIBILITY_ENABLED === 'true';
}

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

/**
 * MCP tools/call の結果は MCP 仕様上 `result.content: [{type:"text", text}]` で返す必要がある。
 * 生のオブジェクトを result に入れると spec 準拠 MCP クライアント (Anthropic mcp_toolset) は
 * content[] が無いため「空応答」と解釈しエージェントに何も渡さない (実測バグ)。
 */
function rpcToolResult(id: string | number | null, payload: unknown, isError = false): NextResponse {
  let text: string;
  if (typeof payload === 'string') {
    text = payload;
  } else {
    try {
      text = JSON.stringify(payload) ?? String(payload);
    } catch {
      text = String(payload);
    }
  }
  return rpcOk(id, { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });
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
// ツール定義: list / read / write。
// place-file / fetch-file は customer_record フォームでは未対応のため disabled のまま。
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'list',
    description: '書込/読取可能箇所の一覧を返す',
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
  {
    name: 'write',
    description: '箇所への書込 (フォーム単位トランザクション、set op のみ)',
    inputSchema: {
      type: 'object',
      properties: {
        form_id: { type: 'string' },
        ops: {
          type: 'array',
          description: 'WriteOp の配列 (customer_record は kind:"set" のみ)',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['set'] },
              place_id: { type: 'string' },
              value: {},
            },
            required: ['kind', 'place_id'],
          },
        },
        dry_run: { type: 'boolean' },
        idempotency_key: { type: 'string' },
        expected_revision: { type: 'string' },
        provenance: {
          type: 'object',
          properties: {
            source: { type: 'string' },
            run_id: { type: 'string' },
            extracted_from: { type: 'string' },
          },
          required: ['source', 'run_id'],
        },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['form_id', 'ops', 'dry_run', 'idempotency_key', 'provenance'],
    },
  },
];

// read-only 窓口が拒否する未対応 write 系 op (fail-closed)。place-file は customer_record で未対応。
const WRITE_OPS = new Set(['place-file']);
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

    // 未対応 write 系 (place-file 等) は一律 disabled (fail-closed)
    if (WRITE_OPS.has(toolName)) {
      return rpcToolResult(id, {
        ok: false,
        reason: 'このツールでは未対応の op です (customer_record フォームは place-file 非対応)。',
      }, true);
    }
    // op 解決: read 系 + write
    const opMap: Record<string, string> = { ...READ_OPS, write: 'write' };
    if (!opMap[toolName]) {
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

    // write の place は各 op 内 (place_id) に存在し top-level には無い。
    // top-level auth は place_id=undefined で行い、per-op enforcement で別途強制する。
    const placeId = (toolArgs.place_id as string) ?? undefined;

    // 書き込み可逆性レイヤー: flag ON かつ write op の場合のみ origin-ai validate を
    // handshake 内 (reversibility.ts: intent→validate→apply→audit) に遅延する。
    // JWT 検証 + ローカル認可は authenticateMcpRequest 内で必ず実行される (fail-closed 維持)。
    // read 系 / flag OFF は従来通り validate 込みで認証する。
    const reversibilityOn = isReversibilityEnabled();
    const deferOriginValidate = reversibilityOn && opMap[toolName] === 'write';

    const authResult = await authenticateMcpRequest(authHeader, {
      op: opMap[toolName],
      form_id,
      place_id: placeId,
      target_type: targetType,
      target_id: targetId,
      session_id: sessionId || undefined,
      agent_id: agentId || undefined,
    }, deferOriginValidate);
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
          return rpcToolResult(id, result.data);
        }
        case 'read': {
          const result = await handleRead(
            { form_id, place_id: toolArgs.place_id as string, index: toolArgs.index as number | undefined },
            resolvedTargetId,
          );
          if (!result.ok) return rpcErr(id, INVALID_PARAMS, result.message);
          return rpcToolResult(id, result.data);
        }
        case 'write': {
          // ── ops は non-empty array でなければならない (fail-closed) ──
          if (!Array.isArray(toolArgs.ops) || toolArgs.ops.length === 0) {
            return rpcErr(id, INVALID_PARAMS, 'ops は要素を1つ以上含む配列で指定してください', 400);
          }
          const ops = toolArgs.ops as Array<Record<string, unknown>>;

          // ── op は kind:'set' かつ place_id:'memo' のみ許可 ──
          for (const op of ops) {
            if (op.kind !== 'set') {
              return rpcErr(id, INVALID_PARAMS, `customer_record フォームは op kind "${op.kind}" を許可していません (set のみ)`, 400);
            }
            if (op.place_id !== 'memo') {
              return rpcErr(id, INVALID_PARAMS, `customer_record フォームで書込可能な place_id は "memo" のみです`, 400);
            }
          }

          // ── per-op allowed_places enforcement (fail-closed, apply 前) ──
          // top-level auth は place_id=undefined で place チェックをスキップするため、
          // ここで各 op の place を claims.allowed_places に対して個別強制する。
          {
            const allowedPlaces = claims.allowed_places;
            for (const op of ops) {
              const opPlace = op.place_id as string | undefined;
              if (!opPlace) {
                return rpcErr(id, INVALID_PARAMS, `write op "${op.kind}" には place_id が必要です`, 400);
              }
              const allowed = allowedPlaces.some((ap) => opPlace === ap || opPlace.startsWith(ap + ':'));
              if (!allowed) {
                console.warn(`[api/mcp] write 拒否: place "${opPlace}" は allowed_places に含まれていません (jti=${claims.jti})`);
                return rpcErr(id, AUTH_ERROR, `write op の place "${opPlace}" は allowed_places に含まれていません`, 403);
              }
            }
          }

          // ── dry_run は boolean 必須 (省略/非 boolean は live write へ暗黙フォールバックさせない) ──
          if (typeof toolArgs.dry_run !== 'boolean') {
            return rpcErr(id, INVALID_PARAMS, 'write の dry_run は boolean (true/false) で明示してください。省略は禁止です。', 400);
          }
          const dryRun = toolArgs.dry_run as boolean;

          // ── provenance.source / run_id 必須、run_id は claims.run_id と一致 ──
          const provenance = toolArgs.provenance as { source?: unknown; run_id?: unknown } | undefined;
          if (!provenance || typeof provenance.source !== 'string' || provenance.source.length === 0 ||
              typeof provenance.run_id !== 'string' || provenance.run_id.length === 0) {
            return rpcErr(id, INVALID_PARAMS, 'provenance.source と provenance.run_id (non-empty string) は必須です', 400);
          }
          if (provenance.run_id !== claims.run_id) {
            return rpcErr(id, AUTH_ERROR, 'provenance.run_id がトークンの run_id と一致しません', 403);
          }

          // ── live write は idempotency_key non-empty string 必須 ──
          const idempotencyKey = toolArgs.idempotency_key;
          if (!dryRun && (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0)) {
            return rpcErr(id, INVALID_PARAMS, 'live write には idempotency_key (non-empty string) が必須です', 400);
          }

          // ── form gate: write_enabled=true の時だけ live 実行 (false→ok:false fail-closed) ──
          if (!dryRun) {
            const enabled = await isFormWriteEnabled(form_id);
            if (!enabled) {
              return rpcToolResult(id, {
                ok: false,
                rejected_op: null,
                reason: `フォーム "${form_id}" は write が無効です (write_enabled=false)`,
              }, true);
            }
          }

          // ── 書き込み可逆性レイヤー (flag ON): handshake 経由 ─────────────────
          // intent→validate→handleWrite→audit を reversibility.ts が orchestrate する。
          // purpose (run/undo) は **verified claim** から判定する (caller 供給は信用しない)。
          // reversible は scalar set のみ可逆。非 set / 非 scalar / value 欠落 / 重複 place は
          // handshake 内で fail-closed 拒否される。
          if (reversibilityOn) {
            const rev = await handleReversibleWrite({
              claims,
              form_id,
              target_id: resolvedTargetId,
              ops: ops as unknown as WriteOp[],
              dry_run: dryRun,
              expected_revision: toolArgs.expected_revision as string | undefined,
              provenance: provenance as { source: string; run_id: string; extracted_from?: string },
              confidence: toolArgs.confidence as number | undefined,
            });
            if (!rev.ok) {
              // handshake 失敗 (intent/validate 拒否・origin 到達不能等) は fail-closed。
              return rpcErr(id, AUTH_ERROR, rev.reason, rev.status);
            }
            // handshake 内の apply 結果。write 失敗は 200 + ok:false (legacy と同形式)。
            return rpcToolResult(id, rev.write, (rev.write as { ok?: unknown })?.ok === false);
          }

          // ── 現行 legacy write (flag OFF): handshake 一切なし ─────────────────
          const result = await handleWrite(
            {
              form_id,
              ops: ops as unknown as WriteOp[],
              dry_run: dryRun,
              idempotency_key: (idempotencyKey as string) ?? '',
              expected_revision: toolArgs.expected_revision as string | undefined,
              provenance: provenance as { source: string; run_id: string; extracted_from?: string },
              confidence: toolArgs.confidence as number | undefined,
            },
            resolvedTargetId,
            claims.run_id,
          );
          // write 失敗も 200 + ok:false で返す (JSON-RPC error にしない)
          return rpcToolResult(id, result, (result as { ok?: unknown })?.ok === false);
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
