/**
 * Core 入口鍵 (tool→Core の X-Internal-API-Key) の解決とリトライ helper。
 *
 * 接続鍵 Core 集約 (origin-core #332)。代表ツール ys-staff-tool の確定パターンを複製。
 *
 * 設計:
 *   - entry 鍵: per-tool scoped 入口鍵 CORE_CREDENTIAL_KEY を優先。移行期は global
 *     INTERNAL_API_KEY を **retry fallback** として併用する。scoped 鍵が当該 credential /
 *     master route の grant 未付与で 401/403 を返した場合に global 鍵で再試行する
 *     (staged rollout 中=scoped 鍵投入済だが grant 未完備でも既存フロー断絶を防ぐ)。
 *     Phase5 (grant 完備・検証後) に global を除去し Done-1 を最終化する。
 *   - 候補は trim・空除外・重複除外する。
 *   - 401/403 のみ次鍵 retry。network/timeout は鍵差し替えで解決しないため即 throw。
 *   - 非 2xx の body は呼出元へ反射しない (secret/内部情報の反射防止)。status のみ扱う。
 *   - 鍵値はログに出力しない。
 *
 * 設計レビュー: codex APPROVE (2026-06-25)。
 */

/**
 * entry 鍵候補を返す。scoped (CORE_CREDENTIAL_KEY) を先頭、global (INTERNAL_API_KEY) を
 * fallback として続ける。trim・空除外・重複除外済み。
 */
export function getEntryKeys(): string[] {
  const scoped = process.env.CORE_CREDENTIAL_KEY?.replace(/\s+$/, '');
  const globalKey = process.env.INTERNAL_API_KEY?.replace(/\s+$/, '');
  const keys: string[] = [];
  if (scoped) keys.push(scoped);
  if (globalKey && globalKey !== scoped) keys.push(globalKey);
  return keys;
}

export interface FetchWithEntryKeysOptions {
  /** テスト時に fetch を差し替える */
  fetchImpl?: typeof fetch;
  /**
   * entry 鍵を上書きする (テスト/特定 caller 用)。未指定時は getEntryKeys()。
   * 空配列を渡した場合は呼出側で「鍵未設定」エラーを扱うこと (本 helper は throw する)。
   */
  entryKeys?: string[];
}

/**
 * X-Internal-API-Key を entry 鍵候補で順試行する fetch。
 *
 * - 各鍵で fetch し、401/403 かつ次鍵がある場合のみ次鍵で retry。
 * - res.ok もしくは「401/403 以外の非 2xx (=鍵差し替えで解決しない応答)」を得たら
 *   その Response を返す (body は呼出側で扱う / status のみ反射する設計は呼出側責務)。
 * - network/timeout (fetch reject) は即 throw (鍵差し替えで解決しない)。
 * - 全鍵で 401/403 の場合は最後の Response を返す (呼出側で status を扱う)。
 *
 * @param url     リクエスト先 URL。
 * @param init    fetch init。headers は base として使い、X-Internal-API-Key を鍵ごとに上書き付与。
 *                body 付きリクエストは事前に buffer 済みの値 (ArrayBuffer/string) を渡し、retry 再利用すること。
 * @param opts    fetchImpl / entryKeys の上書き。
 */
export async function fetchWithEntryKeys(
  url: string,
  init: RequestInit,
  opts: FetchWithEntryKeysOptions = {},
): Promise<Response> {
  const entryKeys = opts.entryKeys ?? getEntryKeys();
  if (entryKeys.length === 0) {
    throw new Error(
      '[core-entry-keys] CORE_CREDENTIAL_KEY / INTERNAL_API_KEY が未設定です (Core API 認証に必須)',
    );
  }
  const fetchFn = opts.fetchImpl ?? fetch;
  const baseHeaders = new Headers(init.headers);

  let last: Response | null = null;
  for (let i = 0; i < entryKeys.length; i++) {
    const headers = new Headers(baseHeaders);
    headers.set('X-Internal-API-Key', entryKeys[i]);
    // network/timeout は鍵差し替えで解決しないため catch せず即 throw に伝播させる。
    const res = await fetchFn(url, { ...init, headers });
    if (res.ok) return res;
    // 401/403 (scoped 鍵の grant 未付与等) で次の entry 鍵 (global) があれば retry。
    if ((res.status === 401 || res.status === 403) && i < entryKeys.length - 1) {
      // body を読み捨ててから次鍵へ (反射しない・接続を解放)。
      try {
        await res.arrayBuffer();
      } catch {
        /* ignore */
      }
      last = res;
      continue;
    }
    return res;
  }
  // 全鍵 401/403。最後の Response を返す (呼出側で status を扱う)。
  // last は必ず非 null (ループは最低 1 回 entry 鍵を試行する)。
  return last as Response;
}
