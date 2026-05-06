# auth-fetch checker

`scripts/check-auth-fetch.mjs` は、書き込み系 API 呼び出し（POST / PUT / PATCH / DELETE）が
Bearer トークン無しの生 `fetch()` で行われていないかを AST で検査する CI チェッカーです。

## 何を防ぐか

Supabase Auth セッションのアクセストークン（Bearer）を付け忘れた `fetch()` で書き込み系 API を叩くと、
401 が返るがトーストやエラー画面が出ず、UI 上は何も起きていないように見える「401 ホワイトアウト」が起きます。
レビューやテストで気付けない回帰の原因になりやすいので、CI で機械的に弾きます。

## 検出対象 / 非対象

検出するのはすべての条件を満たすケースのみ。

| 条件 | 内容 |
|---|---|
| 関数名 | 識別子 `fetch`（メソッド呼び出しや別名は対象外） |
| URL | 文字列 / テンプレ literal で `apiUrlPattern`（既定: `^/api(/|$)`）に一致 |
| method | `POST` / `PUT` / `PATCH` / `DELETE` のいずれか |
| 認証 | `headers` に `Authorization: Bearer ...` / `authHeaders()` / `...authHeaders()` が無い |
| publicPrefixes | 設定された公開プレフィックスに該当しない |

GET 等の参照系、外部 URL への fetch、`react-query` 経由の HTTP クライアントは対象外。

## 違反時の修正例

```ts
// ❌ Bearer 未付与の生 fetch
await fetch("/api/products", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
```

各リポに `lib/auth-fetch.ts` を用意し、Supabase セッションから `access_token` を取り出して
Authorization に詰めるラッパーを使うのが正解です。

```ts
// ✅ authFetch ヘルパー経由
import { authFetch } from "@/lib/auth-fetch";

await authFetch("/api/products", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
```

参考実装は origin-core の [`client/src/lib/auth-fetch.ts`](https://github.com/originaiagent/origin-core/blob/main/client/src/lib/auth-fetch.ts)。
Supabase `getSession()` で `access_token` を取得し、Authorization が未指定のときだけ付与するシンプルなラッパーです。

```ts
import { supabase } from "./supabase";

export async function authFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const headers = new Headers(init.headers);
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return fetch(input, { ...init, headers, credentials: "include" });
}
```

## SKIP / ERROR の挙動

| 状況 | 挙動 |
|---|---|
| `sourceRoots`（既定 `client/src`, `src`）が 1 つも存在しない | `SKIP` (exit 0) — 純バックエンドリポを想定 |
| 上記が存在するが `typescript` 未インストール | `ERROR` (exit 1) — 形骸化防止のため明示エラー |
| 違反検出 | exit 1（CI ブロック） |
| 違反なし | exit 0 |

`typescript` 未インストール時に SKIP しないのは、フロントエンドが存在するのに
チェックが走っていないことに気付けない事態を防ぐためです。`npm i -D typescript` で解消してください。

## 設定 (`auth-fetch.config.json`)

リポ root に置けば挙動を上書きできます。すべて任意。

```json
{
  "sourceRoots":    ["client/src", "src"],
  "publicPrefixes": ["/api/health", "/api/webhook/"],
  "authHelpers":    ["authFetch", "authHeaders", "useAuthFetch"],
  "apiUrlPattern":  "^/api(/|$)"
}
```

| キー | 既定値 | 用途 |
|---|---|---|
| `sourceRoots` | `["client/src", "src"]` | 走査対象（リポ相対） |
| `publicPrefixes` | `[]` | 認証不要として除外する URL プレフィックス |
| `authHelpers` | `["authFetch", "authHeaders"]` | Authorization 付与扱いとする関数名 |
| `apiUrlPattern` | `^/api(/|$)` | API URL 判定 RegExp（文字列） |

## CI 組み込み

`dispatch-sync.yml` 配布時に各リポの `package.json` の `scripts` に `check:auth-fetch` を
**未設定の場合のみ** 追加します（既存値は上書きしない）。

```bash
npm run check:auth-fetch
```

CI ワークフローに組み込むかは各リポの責任です。例 (`.github/workflows/ci.yml`):

```yaml
- run: npm ci
- run: npm run check:auth-fetch
```

`tsc` と一緒に流したい場合は、各リポの `check` スクリプトを手動で連結してください
（`tool-template` 側からの自動連結は既存設定を壊しうるため行いません）:

```json
{
  "scripts": {
    "check": "tsc && npm run check:auth-fetch",
    "check:auth-fetch": "node scripts/check-auth-fetch.mjs"
  }
}
```

## 配布

このチェッカーは `tool-template` から `dispatch-sync.yml` 経由で全配布対象リポに同期されます。
スクリプト本体（`scripts/check-auth-fetch.mjs`）は常に上書き、
`package.json` の `check:auth-fetch` 行は未設定時のみ追加（非破壊）。
