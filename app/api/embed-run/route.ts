import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import { authorizeInternalApiRoute } from '@/lib/auth/api-auth';

/**
 * embed 入口 (契約 §3): origin-ai /api/embed/run を起動し runs をポーリングする。
 *
 * cs-manager は窓口済ツール (ai_embed_mcp_write_gates: customer_record / write_enabled=true)。
 * 新規 handshake は作らず、実需 work `oneshot:inquiry-to-customer-record` 用の入口配線のみ。
 *
 * fail-closed 規律:
 *   - tier='internal' (X-Internal-API-Key) でのみ到達可能 = ブラウザ直叩き不可。
 *     ブラウザ UI は Server Action (server-only env 注入) → internalFetch 経由でのみ通る。
 *     middleware (NEXT_PUBLIC_CORE_AUTH_ENABLED) が UI 到達者のユーザー認証を担う。
 *   - target_type は 'customer_record' 固定 (他 form への run 流用を 403 で拒否)。
 *   - target_id (= 起票元 ticket) の存在を service_role で確認してから run 発行
 *     (存在しない id への有料 run 起動を拒否 = IDOR / コスト濫用の緩和)。
 *   - EMBED_CLIENT_KEY (per-tool embed key) は **サーバ側 env のみ**。X-Embed-Key として
 *     origin-ai にのみ送出し、レスポンス / ブラウザへは一切露出しない。
 *   - 鍵未配布 (EMBED_CLIENT_KEY / ORIGIN_AI_BASE_URL 未設定) → 503。
 *
 * ⚠️ error には stack / env / 機密を出さない。run_id / status / 件数のみ。
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FORM_ID = 'customer_record';
const WORK_SLUG = 'oneshot:inquiry-to-customer-record';
const POLL_DEADLINE_MS = 150000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

// poll 間隔は既定 2s。テスト時のみ EMBED_RUN_POLL_INTERVAL_MS で短縮 (本番未設定=2s)。
function pollIntervalMs(): number {
  return Number(process.env.EMBED_RUN_POLL_INTERVAL_MS) || 2000;
}

export async function POST(req: NextRequest) {
  // --- 認証ゲート (内部化: Server Action / internalFetch 経由のみ) ---
  const authError = await authorizeInternalApiRoute(req);
  if (authError) return authError;

  const key = process.env.EMBED_CLIENT_KEY?.replace(/\s+$/, '');
  const baseUrl = process.env.ORIGIN_AI_BASE_URL?.replace(/\s+$/, '').replace(/\/$/, '');
  if (!key || !baseUrl) {
    // 鍵未配布 → 503 (UI は「未配布キー待ち」disabled 状態)
    return NextResponse.json(
      { ok: false, reason: 'embed key 未配布 (EMBED_CLIENT_KEY 未設定)' },
      { status: 503 },
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }

  const targetType = typeof body?.target_type === 'string' ? body.target_type : '';
  const targetId = typeof body?.target_id === 'string' ? body.target_id : '';
  if (!targetType || !targetId) {
    return NextResponse.json(
      { ok: false, error: 'target_type / target_id が必要です' },
      { status: 400 },
    );
  }

  // target_type は customer_record 固定 (他 form への run 流用を拒否)。hard guard。
  if (targetType !== FORM_ID) {
    return NextResponse.json(
      { ok: false, error: `target_type は ${FORM_ID} のみ許可されます` },
      { status: 403 },
    );
  }

  // target_id (= 起票元 ticket) は UUID 形式必須。
  if (!isUuid(targetId)) {
    return NextResponse.json({ ok: false, error: 'target_id must be a UUID' }, { status: 400 });
  }

  // target_id の ticket が存在することを正規 service_role 経由で確認
  // (存在しない id への有料 run 起動を拒否)。
  try {
    const sb = await getSupabaseAdmin();
    const { data, error } = await sb
      .from('tickets')
      .select('id')
      .eq('id', targetId)
      .maybeSingle();
    if (error) {
      return NextResponse.json({ ok: false, error: '対象の確認に失敗しました' }, { status: 500 });
    }
    if (!data) {
      return NextResponse.json({ ok: false, error: '対象の問い合わせが見つかりません' }, { status: 404 });
    }
  } catch {
    return NextResponse.json({ ok: false, error: '対象の確認に失敗しました' }, { status: 500 });
  }

  // POST {ORIGIN_AI}/api/embed/run
  let runId: string | undefined;
  try {
    const runResp = await fetch(`${baseUrl}/api/embed/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Embed-Key': key },
      body: JSON.stringify({
        kind: 'oneshot',
        slug: WORK_SLUG,
        target_type: targetType,
        target_id: targetId,
        mode: 'auto',
        input: { target_places: [], attachments: [] },
      }),
      cache: 'no-store',
    });
    if (runResp.status !== 202) {
      return NextResponse.json(
        { ok: false, reason: `embed run 起動失敗: HTTP ${runResp.status}` },
        { status: 502 },
      );
    }
    const runJson: any = await runResp.json().catch(() => ({}));
    runId = runJson?.run_id;
  } catch {
    return NextResponse.json({ ok: false, reason: 'embed run 起動に失敗しました' }, { status: 502 });
  }
  if (!runId) {
    return NextResponse.json({ ok: false, reason: 'run_id が返却されませんでした' }, { status: 502 });
  }

  // poll GET {ORIGIN_AI}/api/embed/runs/{run_id}
  const deadline = Date.now() + POLL_DEADLINE_MS;
  let notFound = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs()));
    let pollResp: Response;
    try {
      pollResp = await fetch(`${baseUrl}/api/embed/runs/${runId}`, {
        headers: { 'X-Embed-Key': key },
        cache: 'no-store',
      });
    } catch {
      continue;
    }
    if (pollResp.status === 404) {
      if (++notFound > 3) {
        return NextResponse.json({ ok: false, reason: 'run が見つかりません' }, { status: 502 });
      }
      continue;
    }
    // transient: 408 / 429 / 5xx は deadline まで retry。
    if (pollResp.status === 408 || pollResp.status === 429 || pollResp.status >= 500) {
      continue;
    }
    if (!pollResp.ok) {
      return NextResponse.json(
        { ok: false, reason: `run poll 失敗: HTTP ${pollResp.status}` },
        { status: 502 },
      );
    }
    let json: any;
    try {
      json = await pollResp.json();
    } catch {
      continue;
    }
    const status = json?.status;
    if (status === 'completed') {
      return NextResponse.json({ ok: true, run_id: runId, status, result: json?.result ?? null });
    }
    if (status === 'failed' || status === 'cancelled') {
      return NextResponse.json(
        { ok: false, run_id: runId, reason: `run ${status}` },
        { status: 502 },
      );
    }
    // running → continue
  }
  return NextResponse.json(
    { ok: false, run_id: runId, reason: 'run poll deadline 超過' },
    { status: 504 },
  );
}
