# pollution-zero checker (v7 R-4 / W-4 テスト B)

`scripts/pollution-zero-verify.mjs` は、業務 UI 通常 URL を fetch し、
test-fixture 由来データが一切露出していないことを CI で機械検証するチェッカーです。

## 何を防ぐか

v7 ゴール §2.1 R-4 / §2.2 W-4 は「test-fixture を本番マスタに混在させても業務 UI に露出しない」ことを要求します。
SDK は `WHERE is_test_fixture=false` をデフォルトで内部強制適用するフェイルセーフを持ちますが、
これが実際に各ツールで効いていることをツール側からブラックボックスで検証する必要があります。

検出した場合の典型的な原因:
- SDK 呼び出し側で `includeTestFixture: true` を誤って指定している
- SDK バージョンが古く R-4/W-4 対応版 (npm `@origin/sdk` >= 0.6.0-alpha.1, PyPI `origin-sdk` >= 0.5.0a1) になっていない
- アプリが SDK を経由せず生の Supabase Client / 生 SQL でマスタを参照している

> v7 失格表現: 「アプリ側 WHERE 句で is_test_fixture=false を除外」は採用しないこと。
> SDK デフォルト除外に依存することが正解。

## 設定ファイル (`pollution-zero.config.json`)

リポ root に置けば opt-in。未配置なら SKIP。

```json
{
  "urls": [
    "https://my-tool.app/products",
    "https://my-tool.app/api/products",
    "https://my-tool.app/dashboard"
  ],
  "timeoutMs": 15000,
  "extraPatterns": [
    "internal-test-marker"
  ]
}
```

| キー | 既定値 | 用途 |
|---|---|---|
| `urls` | (必須) | 業務 UI / API の通常 URL。素の GET、追加ヘッダなしで取得可能なもの |
| `timeoutMs` | `15000` | 1 URL あたりのタイムアウト |
| `extraPatterns` | `[]` | ツール固有の追加検出パターン (RegExp 文字列) |

URL 選定の指針:
- 各マスタ (products / product_groups / mall_settings 等) を表示する代表的な一覧画面
- パラメータ・特殊ヘッダなしで叩ける REST 風 API endpoint
- 認証必須のページでも、redirect 先のログイン画面に fixture が漏れていなければ OK
  (むしろ未認証で漏れているのを検知できるベースラインとして有用)

## 検出パターン

レスポンス本文 (HTML エンティティ最低限デコード後) に以下が 1 件でも含まれていれば検出 (exit 1):

| パターン | RegExp | 想定される露出例 |
|---|---|---|
| `is_test_fixture:true` | `/"is_test_fixture"\s*:\s*true/i` | JSON / `__NEXT_DATA__` 内 |
| `fixture_owner_tool` (非 null) | `/"fixture_owner_tool"\s*:\s*"[^"]+"/i` | JSON 内、null 以外の owner 値 |
| `test-fixture-` 接頭辞 | `/test-fixture-/i` | seed 命名規則文字列の業務面露出 |

エンティティデコード対象: `&quot;` / `&#34;` / `&#x22;` / `&apos;` / `&#39;` / `&amp;`。

## SKIP / ERROR の挙動

| 状況 | 挙動 |
|---|---|
| `pollution-zero.config.json` 不在 | `SKIP` (exit 0) |
| `urls` が空配列 | `SKIP` (exit 0) |
| 設定ファイル不正 JSON | `ERROR` (exit 1) |
| URL 取得失敗 (network / 5xx) | `ERROR` (exit 1) |
| 検出パターン合致 | `ERROR` (exit 1) — log に URL / パターン / context スニペット出力 |
| 4xx (404 / 403 等) | exit 0 (露出パターン非該当なら OK) — 認証必須 UI が redirect-to-login する設計を許容するため意図的 |
| すべて OK | exit 0 |

> 注意: 4xx を露出ゼロとみなすのは、認証ウォールに守られた UI のログイン画面 HTML を ERROR にしないため。
> 4xx 自体を検出したい場合は CI ワークフロー側で別途死活監視を組むこと。

> 動作要件: Node.js 18+ (グローバル `fetch` API 依存)。
> nightly ワークフローは Node 20 を pin。ローカル実行も Node 18 以上を推奨。

## CI 組み込み

`.github/workflows/templates/pollution-zero-nightly.yml.tmpl` が dispatch-sync で
9 ツール (R-4/W-4 対象) のみに `.github/workflows/pollution-zero-nightly.yml` として配布されます。

- スケジュール: 毎日 19:00 UTC (= 04:00 JST、cache-purge nightly の 1 時間後)
- 60 秒以内のジッター付き (origin-core への突入を分散)
- `workflow_dispatch` で手動実行も可
- 失敗時は `pollution-zero-fail` ラベル付きで Issue を自動 open (verify.log 内容を本文に含む)

ローカル実行:
```bash
npm run verify:pollution-zero
```

`package.json` への script は dispatch-sync が **未設定の場合のみ** 追加します (既存値は上書きしない)。

## 配布

このチェッカーは `tool-template` から `dispatch-sync.yml` 経由で 9 ツール限定で同期されます
(1/6 cache-purge と同じ 9 ツール限定スコープ)。

- スクリプト本体 `scripts/pollution-zero-verify.mjs` は常に上書き
- ワークフロー `.github/workflows/pollution-zero-nightly.yml` は常に上書き
- `package.json` の `verify:pollution-zero` 行は未設定時のみ追加 (非破壊)
- `pollution-zero.config.json` は配布対象外 (各ツール所有、opt-in 用)

## 9 ツール (R-4 / W-4 対象)

ec-manager / origintree-logi / lp-generator / origin-ai / product-dev-tool / ys-staff-tool / factory-management / testpilot / origintree-soumu-portal

各ツールは自分の業務 UI URL を `pollution-zero.config.json` に列挙して opt-in する。
