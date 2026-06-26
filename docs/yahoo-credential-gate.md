# Yahoo ショッピング 認証情報ゲート (Core credential 枠)

> **これは cs-manager からの人間/Core ゲート向けドキュメントである。**
> cs-manager は Core DB へ直接書かない (B 案マスタ原則: Core が SSOT)。
> 以下の SQL は Core 管理者が Core DB へ投入する。

---

## 1. `credential_service_definitions` 行設計

`yahoo_shopping` 枠は rakuten_rmesse / line_messaging と同形の構造を取る。

### INSERT SQL (Core 管理者用 / cs-manager は実行しない)

```sql
INSERT INTO credential_service_definitions (
  service_code,
  display_name,
  scope_key_required,
  scope_key_label,
  fields,
  is_active
) VALUES (
  'yahoo_shopping',
  'Yahoo!ショッピング (問い合わせAPI)',
  true,
  'ストアアカウント(sellerId)',
  '[
    {
      "key": "access_token",
      "type": "password",
      "secret": true,
      "required": true,
      "label": "アクセストークン(OAuth2)"
    },
    {
      "key": "seller_id",
      "type": "text",
      "secret": false,
      "required": false,
      "label": "ストアアカウント(sellerId)"
    }
  ]'::jsonb,
  true
);
```

### フィールド詳細

| key | type | secret | required | 説明 |
|---|---|---|---|---|
| `access_token` | `password` | true | true | Yahoo Shopping API の OAuth2 Bearer トークン。有効期限あり (要定期更新)。 |
| `seller_id` | `text` | false | false | Yahoo ストアアカウント (sellerId)。未指定時は `scope_key` (store_id) が使われる。 |

- `scope_key_required=true` / `scope_key_label='ストアアカウント(sellerId)'`
  - Core credential 投入時の scope_key = sellerId (例: `my-yahoo-store`)
  - cs-manager adapter は `ctx.credentials.seller_id` → `ctx.channel.config.store_id` の順で解決

---

## 2. Yahoo Shopping API 認証仕様 (go-live ゲート)

### OAuth2 短命トークン問題 ⚠️ go-live ゲート必須

Yahoo Shopping API (問い合わせ管理 API / externalTalkList・externalTalkDetail) は
**OAuth2 Bearer トークンが短命 (有効期限あり)** である。
静的な access_token をそのまま Core credential に投入すると **失効後に 401 エラー** となる。

go-live 前に以下いずれかを確定・実装すること:

| 対応方針 | 概要 | 備考 |
|---|---|---|
| **A. 定期手動投入** | 管理者が access_token を定期的に Core credential へ再投入 | 短期運用向け。自動化なし。 |
| **B. refresh_token 自動更新** | Core credential に `refresh_token` + `client_id` + `client_secret` も保持し、adapter 呼出前に自動更新 | adapter に refresh 未実装。go-live 前に実装必要。 |
| **C. Server-to-Server (S2S)** | Yahoo Shopping の S2S 認証方式があれば利用 | 公式ドキュメント要確認。 |

> **現状**: adapter に token refresh は未実装。
> モックE2E 段階ではキー無で graceful skip するため問題なし。
> 実 Yahoo API 有効化前に上記いずれかを選択・実装すること。

---

## 3. graceful skip vs misconfig の区別

cs-manager の Yahoo adapter (`src/channels/yahoo/adapter.ts`) は以下を区別する:

### credential 不在 (graceful skip) — Core 404 相当

- **条件**: Core `/api/credentials/yahoo_shopping?scope_key=<store_id>` が 404 を返す
  (orchestrator が credential を取得できなかった場合、`ctx.credentials` が空 or undefined)
- **挙動**: orchestrator が当該チャネルをスキップ (loud ログなし)
  - キー投入後の次 tick から自動稼働する
  - 開発・テスト段階では常にこの状態 (graceful)

### credential 存在するが seller_id も store_id も無い (misconfig — loud error)

- **条件**: Core credential は取得できたが、
  `ctx.credentials.seller_id` / `ctx.credentials.store_id` および
  `ctx.channel.config.store_id` / `ctx.channel.config.seller_id` が**全て空**
- **挙動**: adapter が `Error: yahoo.fetchInbox: sellerId not found ...` を throw
  - orchestrator が loud エラーとして記録 (graceful skip ではない)
  - 運用ミス (credential 投入後に sellerId を設定し忘れ等) として検知させる

**設計根拠**: credential が存在するのに seller_id が無い状態は「投入作業が半端」な
  misconfiguration であり、黙って skip すると問題が隠れる。misconfig は大声で失敗させる。

---

## 4. cs-manager channels テーブル設定

go-live 時に以下を確認/投入する (Core 管理者ではなく cs-manager DB 管理者が実施):

```sql
-- channels テーブルの Yahoo 行が以下の config を持つことを確認
UPDATE channels SET config = jsonb_set(
  config,
  '{store_id}',
  '"<実際の sellerId>"'
) WHERE code = 'yahoo' AND status = 'active';
```

- `config.ingestion = 'pull'` — orchestrator が pull adapter として認識
- `config.service_code = 'yahoo_shopping'` — Core credential の service_code と一致
- `config.scope_key_field = 'store_id'` — scope_key として config.store_id を使用
- `config.store_id = '<sellerId>'` — 実際の Yahoo ストアアカウント ID

> `store_id` は Core credential の `seller_id` で代替可能。
> Core credential に `seller_id` を含めれば `channels.config.store_id` は不要。

---

## 5. go-live チェックリスト

- [ ] Core `credential_service_definitions` に `yahoo_shopping` 行を INSERT (上記 SQL)
- [ ] Yahoo OAuth2 アプリを申請・取得 (access_token + refresh_token)
- [ ] Core credential に `yahoo_shopping / scope_key=<sellerId>` で access_token を投入
- [ ] `channels` テーブルの Yahoo 行の `config.store_id` を設定 (または credential に seller_id)
- [ ] token refresh 方針を確定・実装 (go-live ゲート §2)
- [ ] モック E2E で Yahoo 受信 → ticket_drafts 生成を確認 (orchestrator 結線後)
- [ ] 実 Yahoo API でスモークテスト (rate limit 1req/s に注意)
