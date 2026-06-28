/**
 * MCP run-scoped JWT 検証モジュール (§5.3)
 *
 * 2段階 fail-closed 認証:
 *   1. JWKS (RS256) によるローカル JWT 署名/exp/iss/aud/claims 検証
 *   2. origin-ai の validate endpoint による ai_embed_runs 照合コールバック
 *
 * いずれかが失敗/タイムアウト → 403 で拒否 (握り潰さない)。
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

/** JWT に含まれる claim セット */
export interface McpJwtClaims {
  iss: string;
  aud: string | string[];
  sub: string;
  jti: string;
  run_id: string;
  source_tool: string;
  work_slug?: string;
  mode?: string;
  target_type: string;
  target_id: string;
  allowed_ops: string[];
  allowed_places: string[];
  session_id?: string;
  agent_id?: string;
  mcp_server_name: string;
  // 書き込み可逆性レイヤー (v4):
  //   purpose            — 'run' (通常 write) | 'undo' (取り消し)。route が verified claim から判定する。
  //   source_request_id  — intent 呼出に必要な origin 側のリクエスト相関 ID (通常 write で必須)。
  //   undo の場合は claim に write_id / idempotency_key / payload_hash / expected_revision が含まれる。
  purpose?: string;
  source_request_id?: string;
  write_id?: string;
  idempotency_key?: string;
  payload_hash?: string;
  expected_revision?: string;
  exp: number;
  iat: number;
}

/** 認証成功時に返すコンテキスト */
export interface McpAuthContext {
  claims: McpJwtClaims;
}

/** 認証失敗時のエラー */
export interface McpAuthError {
  status: 401 | 403;
  message: string;
}

export type McpAuthResult =
  | { ok: true; ctx: McpAuthContext }
  | { ok: false; err: McpAuthError };

/** 各ツール呼出のリクエスト情報 */
export interface McpOpRequest {
  op: string;           // 'list' | 'read' | 'write' | 'fetch-file' | 'place-file'
  form_id: string;
  place_id?: string;    // list は place_id 不要
  target_type: string;
  target_id: string;
  session_id?: string;
  agent_id?: string;
  // [P2] defense-in-depth: origin-ai validate callback にも form_id を含める
}

// ---------------------------------------------------------------------------
// JWKS キャッシュ (プロセス寿命単位)
// ---------------------------------------------------------------------------

let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksCacheUrl: string | null = null;

function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  const originAiBaseUrl = process.env.ORIGIN_AI_BASE_URL;
  if (!originAiBaseUrl) {
    throw new Error('ORIGIN_AI_BASE_URL が設定されていません');
  }
  const jwksUrl = `${originAiBaseUrl}/api/embed/mcp/jwks.json`;

  // URL が変わった場合はキャッシュを再構築する
  if (!jwksCache || jwksCacheUrl !== jwksUrl) {
    jwksCache = createRemoteJWKSet(new URL(jwksUrl));
    jwksCacheUrl = jwksUrl;
  }
  return jwksCache;
}

// ---------------------------------------------------------------------------
// JWT 検証 (ステップ 1)
// ---------------------------------------------------------------------------

async function verifyJwt(token: string): Promise<{ ok: true; claims: McpJwtClaims } | { ok: false; err: McpAuthError }> {
  const mcpServerName = process.env.MCP_SERVER_NAME;
  if (!mcpServerName) {
    return { ok: false, err: { status: 403, message: 'MCP_SERVER_NAME 未設定 (fail-closed)' } };
  }
  const originAiBaseUrl = process.env.ORIGIN_AI_BASE_URL;
  if (!originAiBaseUrl) {
    return { ok: false, err: { status: 403, message: 'ORIGIN_AI_BASE_URL 未設定' } };
  }

  let jwks: ReturnType<typeof createRemoteJWKSet>;
  try {
    jwks = getJwks();
  } catch (e) {
    console.error('[mcp/auth] JWKS 初期化エラー:', (e as Error).message);
    return { ok: false, err: { status: 403, message: 'JWKS 初期化失敗' } };
  }

  let payload: McpJwtClaims;
  try {
    const result = await jwtVerify(token, jwks, {
      algorithms: ['RS256'],
      issuer: originAiBaseUrl,
      audience: mcpServerName,
      requiredClaims: ['exp', 'iss', 'aud', 'jti', 'run_id'],
    });
    payload = result.payload as unknown as McpJwtClaims;
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    console.error('[mcp/auth] JWT 検証失敗:', msg);
    return { ok: false, err: { status: 401, message: `JWT 検証失敗: ${msg}` } };
  }

  // requiredClaims に含まれない必須フィールドを手動チェック
  if (!payload.run_id || !payload.target_type || !payload.target_id || !payload.mcp_server_name) {
    return { ok: false, err: { status: 401, message: 'JWT claims 不足 (run_id/target_type/target_id/mcp_server_name)' } };
  }
  if (!Array.isArray(payload.allowed_ops) || !Array.isArray(payload.allowed_places)) {
    return { ok: false, err: { status: 401, message: 'JWT claims 不足 (allowed_ops/allowed_places)' } };
  }

  return { ok: true, claims: payload };
}

// ---------------------------------------------------------------------------
// op/place/target 認可チェック (ステップ 2 - ローカル)
// ---------------------------------------------------------------------------

function checkLocalAuthorization(claims: McpJwtClaims, opReq: McpOpRequest): McpAuthError | null {
  // op が allowed_ops に含まれるか
  if (!claims.allowed_ops.includes(opReq.op)) {
    return { status: 403, message: `op "${opReq.op}" は allowed_ops に含まれていません` };
  }

  // target_type / target_id が一致するか
  if (claims.target_type !== opReq.target_type) {
    return { status: 403, message: `target_type 不一致: claim=${claims.target_type} req=${opReq.target_type}` };
  }
  if (claims.target_id !== opReq.target_id) {
    return { status: 403, message: `target_id 不一致: claim=${claims.target_id} req=${opReq.target_id}` };
  }

  // place_id が指定されている場合は allowed_places に含まれるか確認
  if (opReq.place_id && opReq.place_id !== '*') {
    if (!claims.allowed_places.includes(opReq.place_id)) {
      return { status: 403, message: `place_id "${opReq.place_id}" は allowed_places に含まれていません` };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// origin-ai コールバック照合 (ステップ 3)
// ---------------------------------------------------------------------------

async function validateWithOriginAi(
  claims: McpJwtClaims,
  opReq: McpOpRequest,
): Promise<{ ok: true } | { ok: false; err: McpAuthError }> {
  const originAiBaseUrl = process.env.ORIGIN_AI_BASE_URL;
  // embed validate コールバックの共有検証鍵: EMBED_MCP_VALIDATE_KEY(専用)優先、無ければ
  // Core core_internal_shared(origin-ai validate が受理する全ツール共通値)。接続鍵 Core 集約
  // Done-1 で global env INTERNAL_API_KEY 直読みは廃止。
  const { getSharedInternalApiKey } = await import('@/lib/credentials');
  const internalApiKey = await getSharedInternalApiKey();

  if (!originAiBaseUrl) {
    return { ok: false, err: { status: 403, message: 'ORIGIN_AI_BASE_URL 未設定' } };
  }
  // 鍵未解決 (EMBED_MCP_VALIDATE_KEY 無し かつ Core 解決不可) は無認証で origin-ai を叩かず
  // ローカルで fail-closed (codex 必須#5)。下流 validate が鍵なしを 401 にする前に止める。
  if (!internalApiKey) {
    return { ok: false, err: { status: 403, message: 'embed validate 検証鍵 未解決 (fail-closed)' } };
  }

  const body = {
    jti: claims.jti,
    run_id: claims.run_id,
    op: opReq.op,
    form_id: opReq.form_id,   // [P2] defense-in-depth: origin-ai 側でも form_id を検証できる
    place_id: opReq.place_id ?? null,
    target_type: opReq.target_type,
    target_id: opReq.target_id,
    session_id: opReq.session_id ?? claims.session_id ?? null,
    agent_id: opReq.agent_id ?? claims.agent_id ?? null,
    mcp_server_name: claims.mcp_server_name,
  };

  let resp: Response;
  try {
    // 5秒タイムアウト: タイムアウトは fail-closed
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    resp = await fetch(`${originAiBaseUrl}/api/embed/mcp/validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-API-Key': internalApiKey,
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    clearTimeout(timer);
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    console.error('[mcp/auth] origin-ai validate タイムアウト/ネットワークエラー:', msg);
    // fail-closed
    return { ok: false, err: { status: 403, message: 'origin-ai validate 到達不能 (fail-closed)' } };
  }

  if (!resp.ok) {
    console.error('[mcp/auth] origin-ai validate 非200:', resp.status);
    return { ok: false, err: { status: 403, message: `origin-ai validate 失敗: HTTP ${resp.status}` } };
  }

  let json: { valid: boolean; reason?: string };
  try {
    json = await resp.json();
  } catch {
    return { ok: false, err: { status: 403, message: 'origin-ai validate レスポンス parse 失敗' } };
  }

  if (!json.valid) {
    console.error('[mcp/auth] origin-ai validate valid=false:', json.reason);
    return { ok: false, err: { status: 403, message: `origin-ai validate 拒否: ${json.reason ?? 'unknown'}` } };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// メイン認証関数 (全 MCP call で先行実行)
// ---------------------------------------------------------------------------

/**
 * Authorization: Bearer <JWT> ヘッダを検証し、op/place/target の認可も確認する。
 * いずれかの段階で失敗した場合は fail-closed で McpAuthError を返す。
 *
 * @param authHeader          - req.headers.get('authorization')
 * @param opReq               - 実行しようとする操作の情報
 * @param deferOriginValidate - true の場合、ステップ3 (origin-ai validate) を **スキップ** する。
 *                              書き込み可逆性レイヤー (flag ON の write) では validate を
 *                              handshake 内 (intent→validate→apply→audit) で実施するため、ここでは
 *                              JWT 検証 + ローカル認可のみ行う。read 系・flag OFF は false (validate 込み)。
 *                              JWT/ローカル認可は **常に** 実行されるため fail-closed は維持される。
 */
export async function authenticateMcpRequest(
  authHeader: string | null,
  opReq: McpOpRequest,
  deferOriginValidate = false,
): Promise<McpAuthResult> {
  // Bearer トークン抽出
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, err: { status: 401, message: 'Authorization ヘッダが必要です (Bearer <JWT>)' } };
  }
  const token = authHeader.slice(7).trim();
  if (!token) {
    return { ok: false, err: { status: 401, message: 'Bearer トークンが空です' } };
  }

  // ステップ 1: JWT 署名/exp/iss/aud 検証
  const jwtResult = await verifyJwt(token);
  if (!jwtResult.ok) return jwtResult;
  const { claims } = jwtResult;

  // ステップ 2: ローカル認可チェック (op / place_id / target)
  const authError = checkLocalAuthorization(claims, opReq);
  if (authError) return { ok: false, err: authError };

  // ステップ 3: origin-ai コールバック照合
  // deferOriginValidate=true の場合は handshake 内 (reversibility.ts) で validate を行うため
  // ここではスキップする。JWT 検証 + ローカル認可は上で完了しているため fail-closed は維持される。
  if (!deferOriginValidate) {
    const validateResult = await validateWithOriginAi(claims, opReq);
    if (!validateResult.ok) return validateResult;
  }

  return { ok: true, ctx: { claims } };
}
