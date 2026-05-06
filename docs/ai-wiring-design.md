# AI 呼び出し配管 設計書 (tool-template SoT)

**作成日: 2026-04-25**
**親ゴール: dev_backlog 39886a1f「全ツール AI 呼び出し配管整備」**
**準拠: guides slug=ai-centralization-principle / ai-centralization-invocation-pattern**

---

## 0. 目的とスコープ

### 目的
全 14 ツールから origin-ai を呼び出すための共通配管を、3 スタック (Next.js / Node / Python) で雛形化し tool-template に SoT を置く。各ツールには tool-template 経由で配布し、ユースケース未確定でも「キッチン入口完備」状態にする。

### スコープに含めるもの (契約非依存・本タスク)
- 認証ヘッダ管理 (`X-Internal-API-Key` 規約)
- HTTP クライアント (タイムアウト / リトライ / エラーマッピング)
- エラー型階層
- ロギング / 相関 ID トレース
- UI 部品雛形 (Next.js のみ: 起動ボタン / Loading / エラー表示)
- 環境変数管理 (.env.example、必須変数バリデーション)

### スコープ外 (Phase 7 / 別タスク)
- 具体的な payload shape / ワークフローID / agent name (bf9cc6e2 完了後に確定)
- 個別ユースケース実装 (シーン毎の AI ワークフロー、別タスク 8e7413de)
- origin-ai 本体のコード変更 / DB 書き込み

---

## 1. 起動規約 (SoT: guides ai-centralization-invocation-pattern)

各ツール → origin-ai の起動は **2 パターンのみ**。

### パターン A: チャット起動 (`invokeChat`)
- 入力: ユーザーが打った文字列 (**そのまま、加工禁止**) + 認証ヘッダ
- 送ってはいけないもの: 文脈情報、状態情報、画面情報、ツール側組立プロンプト
- エンドポイント: `POST {ORIGIN_AI_URL}/api/chat/sync`

### パターン B: ボタン / イベント起動 (`invokeWorkflow`)
- 入力: ワークフローID (文字列) + 構造化 JSON データ + 認証ヘッダ
- 送ってはいけないもの: プロンプト文字列、ワークフロー側の指示内容
- エンドポイント: `POST {ORIGIN_AI_URL}/api/managed-agent/run`

### 正当な「裏方データ」(プロンプトではない)
- 認証ヘッダ (`X-Internal-API-Key`)
- ツール識別ラベル (`X-Tool-Name`、ルーティング用メタデータ)
- 相関 ID (`X-Request-Id`、トレース用)

---

## 2. 環境変数規約

| 変数名 | 必須 | 説明 |
|---|---|---|
| `ORIGIN_AI_URL` | ✅ | origin-ai のベース URL (例: `https://origin-ai-five.vercel.app`)。末尾スラッシュは自動除去。 |
| `ORIGIN_AI_API_KEY` | ✅ | origin-ai の `INTERNAL_API_SECRET` と同一値。`X-Internal-API-Key` ヘッダで送信。 |
| `ORIGIN_AI_TIMEOUT_MS` | 任意 | デフォルト: chat=90000 / workflow=270000。上書き可。 |
| `ORIGIN_AI_TOOL_NAME` | 任意 | ツール識別ラベル。未指定時は package.json name (Node/Next) または OS env から推定。 |

**実態優先採用**: 既存 origin-core では `ORIGIN_AI_URL` / `ORIGIN_AI_API_KEY` が定着。指示文の `ORIGIN_AI_BASE_URL` / `ORIGIN_AI_INTERNAL_KEY` ではなく実態を採用。

**バリデーション**: 起動時に `ORIGIN_AI_URL` と `ORIGIN_AI_API_KEY` の存在を確認し、未設定なら `OriginAiConfigError` を即座に投げる。

---

## 3. 共通 API シグネチャ

3 スタック共通の最小契約 (具体的シグネチャは各スタックの慣習に合わせる)。

### TypeScript (Next.js / Node)
```ts
// チャット起動 (パターンA)
async function invokeChat(
  message: string,
  options?: InvokeOptions
): Promise<ChatResult>;

// ワークフロー起動 (パターンB)
async function invokeWorkflow(
  workflowId: string,
  data: Record<string, unknown>,
  options?: InvokeOptions
): Promise<WorkflowResult>;

interface InvokeOptions {
  timeoutMs?: number;       // デフォルト: chat=90000 / workflow=270000
  traceId?: string;         // 未指定なら crypto.randomUUID()
  signal?: AbortSignal;     // 呼び出し側のキャンセル制御
  userId?: string;          // ユーザー識別 (任意)
}

interface ChatResult {
  message: string;
  structuredOutput?: Record<string, unknown>;
  skillUsed?: { name: string; displayName?: string };
  traceId: string;
  durationMs: number;
}

interface WorkflowResult {
  result: string;
  sessionId?: string;
  traceId: string;
  durationMs: number;
}
```

### Python (Streamlit)
```py
def invoke_chat(message: str, *, timeout_ms: int | None = None,
                trace_id: str | None = None, user_id: str | None = None
                ) -> ChatResult: ...

def invoke_workflow(workflow_id: str, data: dict, *,
                    timeout_ms: int | None = None, trace_id: str | None = None
                    ) -> WorkflowResult: ...
```

---

## 4. エラー型階層

全スタック共通のエラー分類:

| エラー型 | HTTP/原因 | リトライ | UX |
|---|---|---|---|
| `OriginAiConfigError` | 環境変数未設定 | ❌ | 「管理者に問い合わせ」表示 |
| `OriginAiAuthError` | 401 / 403 | ❌ | 同上、key prefix を log に残す |
| `OriginAiTimeoutError` | AbortError, TimeoutError | ✅ (1 回) | 「処理に時間がかかっています」表示 |
| `OriginAiNetworkError` | fetch reject / DNS / connection refused | ✅ (最大 2 回、指数バックオフ) | 「一時的な接続エラー」表示 |
| `OriginAiServerError` | 5xx | ✅ (1 回) | 「origin-ai 側で問題発生」表示 |
| `OriginAiClientError` | 4xx (上記以外) | ❌ | エラーメッセージ表示 |
| `OriginAiUnknownError` | 上記以外 | ❌ | 汎用エラー表示 |

**継承構造**: 全て `OriginAiError` を基底とする。各クラスは `code`, `status`, `traceId`, `responseBody` を保持。

**フォールバック挙動**: origin-ai 障害時は静かに失敗させず、必ずユーザーにエラー表示。SLA を守るためにフェイクの応答を返すのは禁止 (AI 集約原則違反)。

---

## 5. リトライ / タイムアウト デフォルト

| パラメータ | デフォルト |
|---|---|
| chat タイムアウト | 90 秒 |
| workflow タイムアウト | 270 秒 (origin-ai 側 fetch 上限) |
| ネットワークエラー再試行回数 | 2 |
| 5xx 再試行回数 | 1 |
| バックオフ | 1s → 2s (指数) + jitter ±200ms |
| 同一リクエストの全体上限 | timeout × (retry + 1) |

**冪等性**: workflow 起動はサーバ側で workflow_id + trace_id で冪等化される前提 (Phase 7 で確定)。本配管はリトライを行うが、副作用ありを前提とした保守的デフォルト (5xx は 1 回のみ)。

---

## 6. ロギング / トレース

### 必須ログ項目
| 項目 | 値 |
|---|---|
| `trace_id` | UUID v4 (header `X-Request-Id` と同値) |
| `tool_name` | 環境変数 or 自動推定 |
| `pattern` | "chat" or "workflow" |
| `endpoint` | URL (key 等は伏字化) |
| `duration_ms` | 計測値 |
| `status` | "success" / "error" |
| `error_code` | エラー時のみ |

### ログ出力形式
- Next.js / Node: 構造化 JSON (`console.log(JSON.stringify({...}))`、後続で pino 等への差し替え可)
- Python: `logging` モジュール + JSON formatter

### 機微情報の取扱
- `ORIGIN_AI_API_KEY` 全文は **絶対にログに残さない**。デバッグ時は prefix 6 文字のみ (例: `key_prefix=abc123...`)
- ユーザー入力 (message) はデフォルトでログに残さない (PII 懸念)。`ORIGIN_AI_LOG_PAYLOAD=true` で開発時のみ有効化。

---

## 7. UI 部品 (Next.js のみ)

### 提供範囲
- `<OriginAiButton />` — クリック起動 (パターン B 用)。loading / disabled / error 状態を内蔵
- `<OriginAiChatInput />` — チャット入力 (パターン A 用)。送信中のロック制御
- `<OriginAiResult />` — 結果 / エラー表示の最小ラッパ

### 設計方針
- **ヘッドレス寄り**: スタイリングは Tailwind classes を minimal で受け取る props ベース。各ツールの design-system に依存させない
- **「実行中はUI入力ブロック」原則** (guides ai-centralization-principle §4): 実行中は input/button を disable
- **エラー表示**: `OriginAiError` の種別に応じて文言を出し分け

### 配布範囲
Next.js 8 ツールのみ。Node / Python は配布対象外 (Express/Streamlit は別構造のため雛形を別途用意)。

---

## 8. ファイル構成 (各スタック共通)

### Next.js
```
templates/nextjs/
├── lib/origin-ai/
│   ├── index.ts          # 公開API (invokeChat / invokeWorkflow / 型 / エラー)
│   ├── client.ts         # HTTP クライアント実装
│   ├── auth.ts           # 認証ヘッダ生成
│   ├── errors.ts         # エラー型階層
│   ├── logger.ts         # 構造化ログ
│   └── config.ts         # 環境変数読込・バリデーション
├── components/origin-ai/
│   ├── OriginAiButton.tsx
│   ├── OriginAiChatInput.tsx
│   └── OriginAiResult.tsx
├── __tests__/origin-ai/
│   └── client.test.ts    # ダミー fetch テスト
├── README.md             # 使い方
└── .env.example.snippet  # 既存 .env.example に追記する内容
```

### Node (Cloud Run / Express 想定)
```
templates/node/
├── lib/origin-ai/
│   ├── index.ts
│   ├── client.ts
│   ├── auth.ts
│   ├── errors.ts
│   ├── logger.ts
│   └── config.ts
├── __tests__/origin-ai/
│   └── client.test.ts
├── README.md
└── .env.example.snippet
```

### Python (Streamlit)
```
templates/python/
├── origin_ai/
│   ├── __init__.py       # 公開API
│   ├── client.py         # HTTP クライアント (httpx)
│   ├── auth.py
│   ├── errors.py
│   ├── logger.py
│   ├── config.py
│   └── ui.py             # Streamlit UI 雛形
├── tests/
│   └── test_client.py
├── README.md
├── requirements.snippet  # 追加するライブラリ
└── .env.example.snippet
```

---

## 9. Phase 7 (契約依存) 拡張ポイント

bf9cc6e2 (origin-ai 大掃除) 完了後に追加する部分。本配管の以下の場所に「拡張ポイント」を明示コメントで残す。

### 拡張ポイント 1: ワークフロー定義 (型のみ用意、実体は Phase 7)
```ts
// templates/nextjs/lib/origin-ai/workflows.ts (Phase 7 で追加)
// export const WORKFLOW_IDS = {
//   EC_ANALYSIS: 'ec-analysis',
//   ...
// } as const;
```
**何を追加するか**: workflow_id の定数化、payload shape の zod スキーマ、各ツール固有のラッパ関数。

### 拡張ポイント 2: agent_name 定数 (チャット用)
```ts
// 同上 agents.ts
// export const AGENT_NAMES = {
//   CORE_ASSISTANT: 'core_assistant',
//   ...
// } as const;
```

### 拡張ポイント 3: ストリーミング対応 (現状: 同期のみ)
- `client.ts` 内に `// TODO Phase 7: SSE streaming 対応` コメントを残す
- 公開 API 互換性を保つため、`invokeChatStream` を別関数として追加予定

### 拡張ポイント 4: ツール固有 context 注入
- 現状、ツール側からは「ユーザー文字列のみ」しか送れない (起動規約準拠)
- Phase 7 で「ツール識別 (`X-Tool-Name`) + ユーザー ID」だけは origin-ai 側にメタデータとして渡す経路を確立済
- 追加で必要なメタデータがあれば origin-ai 側のツール呼び出しで取得 (search_knowledge 等)

### 拡張ポイント 5: 監視 / メトリクス
- 現状: 構造化ログを stdout に出すだけ
- Phase 7: Vercel Analytics / Cloud Logging Sink への送出。`logger.ts` の interface を維持して実装差し替え可能にする

---

## 10. 配布手順 (Phase 4-6)

各ツールリポジトリに以下を配布:

1. `git worktree add ../<tool>-ai-wiring -b claude/ai-wiring-foundation main`
2. tool-template の対応スタックから lib/components をコピー
3. 既存 `.env.example` に `.env.example.snippet` を追記 (該当ファイルがなければ新規作成)
4. README に「AI 呼び出しの使い方」セクションを追記 (リンク or 抜粋)
5. CI 緑確認 → PR 作成 (base=main、title 統一)

**非破壊原則**: 既存ファイル削除 / 改変は最小限。新規ファイル追加 + .env.example の追記のみ。

**Python 系の package layout**: ツール毎に既存構成 (Streamlit app.py 中心 / モジュール分離) が違うため、`origin_ai/` ディレクトリを最上位に配置し、`from origin_ai import invoke_chat, invoke_workflow` で使えるようにする。

---

## 11. テスト方針

### 配管自体の品質ゲート
- 単体テスト: client.ts の HTTP モック (status code → エラー型マッピング)
- 環境変数バリデーション: 未設定で `OriginAiConfigError`
- リトライ動作: 5xx → 1 回再試行 → 失敗で `OriginAiServerError`
- タイムアウト: AbortSignal 経由で `OriginAiTimeoutError`

### 配布先での動作確認
- 本番 origin-ai に対して接続確認は **しない** (bf9cc6e2 と排他のため)
- 各ツールの CI (lint/build/typecheck) が通ることのみ確認
- Phase 7 で実 origin-ai 接続テスト追加

---

## 12. 命名規約 (3 スタックで揃える)

| 概念 | TypeScript | Python |
|---|---|---|
| パッケージ | `origin-ai` (lib/components ディレクトリ) | `origin_ai` (snake_case) |
| チャット起動 | `invokeChat` | `invoke_chat` |
| ワークフロー起動 | `invokeWorkflow` | `invoke_workflow` |
| エラー基底 | `OriginAiError` | `OriginAiError` |
| 環境変数 | `ORIGIN_AI_*` | `ORIGIN_AI_*` |
| トレース ID | `traceId` | `trace_id` |

---

## 13. 既存 origin-core 実装との差分 / 統一点

実態調査で判明した既存パターン:

| 既存実装 | 採用 | 理由 |
|---|---|---|
| `ORIGIN_AI_URL` / `ORIGIN_AI_API_KEY` | ✅ そのまま | 既に origin-core で定着 |
| 認証: `Authorization: Bearer` (toolExecutor.ts) と `X-Internal-API-Key` (managedAgentService.ts) の混在 | ❌ → `X-Internal-API-Key` に統一 | guides ai-centralization-invocation-pattern が SoT。本配管は SoT 準拠。origin-core 側の Bearer 利用箇所は Phase 7 で統一 (本タスクでは触らない) |
| `X-Request-Id` ヘッダ | ✅ そのまま | 相関 ID 規約 |
| timeout 90s (chat) / 270s (workflow) | ✅ そのまま | origin-ai fetch 上限と整合 |

**判断ログ**: origin-core で 2 種類の認証ヘッダが混在していたが、本配管は guide SoT に準拠して `X-Internal-API-Key` に統一。origin-core 側の Bearer 利用箇所は Phase 7 / 別タスクで是正 (本タスクでは origin-core を触らない)。

---

## 14. 違反・逸脱検知ガード

各スタックの公開 API は以下を **ハードコード防止** する:

- システムプロンプトを内部に埋め込む箇所が存在しない
- LLM SDK (`@anthropic-ai/sdk`, `openai`, `anthropic` 等) を import しない
- 公開 API は `invokeChat(message)` と `invokeWorkflow(id, data)` のみ。ツール側でプロンプト組立できる余地を作らない

将来の違反を防ぐため、README に上記原則を明記し、PR レビュー観点として残す。

---

## 15. Done 条件 (本配管整備の完了基準)

- [ ] tool-template に 3 スタック雛形が配置され、PR merge 待ち
- [ ] 14 ツールに配管が配布、PR merge 待ち
- [ ] Gemini 設計レビュー APPROVE 取得済
- [ ] 各ツールの CI が緑
- [ ] Phase 7 拡張ポイントが README + コードコメントに明記

**Phase 7 への引き継ぎ**: bf9cc6e2 完了後、本設計の §9 拡張ポイントに沿って契約依存部分 (workflow_id / agent_name 定数 / payload schema) を追加。
