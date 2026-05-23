/**
 * 一次返信フロー — PII マスク薄ラッパ (origin-ai rag-pii-mask 経由)
 *
 * reply-adapter.ts と同一の境界: 外部 (origin-ai) へ送る前に raw 本文を masked 化する。
 * マスクは origin-ai 側で行い、復元マップ (replacements) を受け取って **ローカルでのみ** 復元する。
 *
 * ハードコード禁止: ORIGIN_AI_URL / 認証鍵は env or Core 解決。本モジュールは
 * 認証鍵を引数で受け取り (orchestrator が Core 解決)、URL のみ env から読む。
 */

import { getCredential } from '@/lib/credentials';

export interface MaskReplacement {
  token: string;
  original: string;
  pii_type: string;
}

export interface MaskTextResult {
  maskedText: string;
  replacements: MaskReplacement[];
  maskFailed: boolean;
}

const RAG_INTERNAL_CRED_SERVICE_CODE =
  process.env.RAG_INTERNAL_CRED_SERVICE_CODE?.replace(/\s+$/, '') ||
  'origin_ai_internal';

const RAG_TIMEOUT_MS = process.env.RAG_TIMEOUT_MS
  ? parseInt(process.env.RAG_TIMEOUT_MS, 10)
  : 60_000;

function resolveOriginAiUrl(): string {
  const url = process.env.ORIGIN_AI_URL?.replace(/\s+$/, '');
  if (!url) throw new Error('ORIGIN_AI_URL is not set');
  return url.replace(/\/$/, '');
}

/** origin-ai rag endpoint 認証鍵を Core 経由で解決 (env 非依存 = B案)。値は log/出力しない。 */
export async function resolveRagInternalKey(): Promise<string> {
  const cred = await getCredential<{ api_key?: string }>(
    RAG_INTERNAL_CRED_SERVICE_CODE,
  );
  const key = cred.credentials?.api_key;
  if (!key) {
    throw new Error(
      `${RAG_INTERNAL_CRED_SERVICE_CODE} credential に api_key フィールドがありません (Core)`,
    );
  }
  return key.replace(/\s+$/, '');
}

/** origin-ai rag-pii-mask で 1 テキストをマスクする。 */
export async function maskText(
  internalKey: string,
  raw: string,
): Promise<MaskTextResult> {
  const url = `${resolveOriginAiUrl()}/api/skills/rag-pii-mask`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-API-Key': internalKey,
    },
    body: JSON.stringify({ texts: [raw] }),
    signal: AbortSignal.timeout(RAG_TIMEOUT_MS),
    cache: 'no-store',
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`rag-pii-mask ${res.status}: ${t.slice(0, 200)}`);
  }
  const j = (await res.json()) as {
    results?: Array<{
      masked_text?: string;
      replacements?: MaskReplacement[];
      mask_failed?: boolean;
    }>;
  };
  const r = j.results?.[0];
  if (!r || r.mask_failed) {
    return { maskedText: '', replacements: [], maskFailed: true };
  }
  return {
    maskedText: r.masked_text ?? '',
    replacements: r.replacements ?? [],
    maskFailed: false,
  };
}

/** masked テキストの全トークンをローカルで復元する (外部呼び出し後のみ実行)。 */
export function restoreLocally(
  text: string,
  replacements: Array<{ token: string; original: string }>,
): string {
  let out = text;
  for (const r of replacements) {
    if (!r.token) continue;
    out = out.split(r.token).join(r.original);
  }
  return out;
}
