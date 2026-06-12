# 設計案: 全モール受信を「Coreにキー投入だけ」で稼働させる (送信は対象外)

## ゴール
受信を全対象チャネルで可能にし、各チャネルの残作業を「Core Vault へのキー投入(＋必要なら申請承認/メール転送設定)」だけにする。送信は今回対象外・全チャネル OFF 維持。

## 段階1 調査結果 (公式ドキュメント裏取り、ヒントは要検証済)
| code | 受信API | 型 | 認証 | 承認/外部ゲート | 出典 |
|---|---|---|---|---|---|
| yahoo | あり | **Pull** | OAuth2 Bearer (Yahoo ID連携) | 利用申請+問い合わせツール権限, 1req/s | developer.yahoo.co.jp/webapi/shopping/question/ (externalTalkList/externalTalkDetail) |
| line | あり | **Push (webhook)** | 受信: x-line-signature(HMAC-SHA256, channel secret) / 返信: channel access token | LINE Developers でチャネル作成のみ | developers.line.biz/en/docs/messaging-api/receiving-messages/ |
| amazon | **受信APIなし** (SP-API Messaging は送信専用。getMessagingActionsForOrder は送信可能種別の列挙のみ) | — | — | Buyer-Seller Messaging 制限ロール承認(送信用) | developer-docs.amazon.com/sp-api/docs/messaging-api-v1-reference |
| aupay | 公式の受信API確認できず (受注/在庫/出荷のみ。仕様はパートナー限定) | — | — | API利用申請+IP登録 | faq.wowma.jp / crossma.jp/manual/api-au-first |
| qoo10 | 公式の受信API確認できず (QAPI は Certification/Shipping/Items/Orders のみ。問い合わせ系メソッド未確認) | — | — | API key 申請 | api.qoo10.jp QAPI Guide (login-gated) |
| own_ec | 自社EC → 既存 email inbound webhook で吸収可 | — | — | メール転送設定 | (自社) |

**結論 (分類):**
- **専用 Pull アダプタを作る: yahoo のみ** (確認済 pull API)。
- **専用 Push webhook を作る: line のみ** (確認済 webhook)。
- **メール転送経路に集約 (専用アダプタ不要): amazon / aupay / qoo10 / own_ec**。受信APIが無い/未確認のため、各モールの問い合わせ通知メールを既存 `POST /api/channels/email/inbound` (正規化契約) に転送して吸収する。これは過剰実装回避＋「受信API無し→メール転送に倒す」方針通り。

## 最上位制約の遵守
- AI集約: ドラフト生成は既存 `generateRagReply` (origin-ai) のみ。LLM 直叩き/prompt 直書きを足さない。
- 認証情報 Core 一元 (B案): 全外部キーは Core `/api/credentials/{service_code}` で call-time 解決。cs-manager DB/env にキーを保存しない。**service_code はアダプタにハードコードせず `channels.config.service_code` で宣言** (現行 rakuten の `'rakuten_rmesse'` ハードコードも config 駆動へ是正)。
- 「キー入れるだけ」定義: 新キーを Core に入れた後、**コード変更ゼロ**で受信開始。

## 設計

### 1. channels.config データ駆動宣言 (additive migration)
各 channel の `config` に受信機構を宣言:
- `ingestion`: `'pull' | 'push_webhook' | 'inbound_webhook'`
- `service_code`: Core Vault のサービスコード (pull/push のみ。例: `yahoo_shopping`, `line_messaging`)
- `scope_key_field`: scope_key を引く config キー名 (既定 `'scope_key'`。rakuten は `'shop_id'`、yahoo は `'store_id'`)

migration 内容 (自専有テーブルへ additive のみ):
- 新規 channel 行追加: `aupay`, `qoo10` (未登録のため)。
- config 更新: yahoo(pull/yahoo_shopping/store_id), line(push_webhook/line_messaging), amazon/aupay/qoo10/own_ec(inbound_webhook + note)。
- status: **yahoo=active, line=active** (credential-gated。キー未投入でも graceful skip)。**own_ec=active** (inbound_webhook、inbox 登録待ち)。**amazon/aupay/qoo10=pending** (受信API無し/承認待ち/メール転送設定待ち、表示のみ)。
- 既存 rakuten: config に `service_code='rakuten_rmesse'`, `scope_key_field='shop_id'` を additive 付与 (挙動不変、ハードコード是正の布石)。

**[codex CONCERN#1 反映] メール転送チャネルの稼働ゲートを明文化:**
`resolveInbox` は `channel_inboxes.status='active'` かつ `channels.status='active'` を要求する。よって amazon/aupay/qoo10 (pending) は inbox を登録しても受信しない。これは意図的: これらは「受信API無し+外部承認/転送設定待ち」で**未稼働が正**。稼働手順 (ゲート項目に明記、いずれも DB 行操作のみ=コード変更ゼロ): (1) 外部フォワーダ設定, (2) `channel_inboxes` に転送先アドレス行を追加, (3) `channels.status` を `active` に 1行トグル。own_ec は自社管理のため最初から active とし、残作業は inbox 行追加のみ。

**[codex CONCERN#4 反映] activation の適用順序:**
migration で yahoo/line を active にする時点で対応 adapter/endpoint が未デプロイだと cron が `no adapter` error になる。よって本 migration は **コード (yahoo adapter 登録 + line endpoint) を merge & Vercel デプロイした後に手動適用** する (supabase MCP, project ID 明示)。activation は adapter/endpoint と同一リリースに含め、適用は post-deploy。これを報告の本番疎通レシピに明記。

### 2. 受信ワーカーの汎用 credential 解決 (「キー入れるだけ」の心臓部)
`ChannelAdapterContext` を拡張: `credentials: Record<string, unknown>` を追加。
orchestrator (`runChannelSync`) を以下に変更:
- 対象: `status='active'` かつ `code != 'rakuten'` (rakuten は専用 cron 継続)。
- `config.ingestion`:
  - `'inbound_webhook'` / `'push_webhook'` → skip (pull cron 対象外。push は各専用 endpoint が受ける)。
  - `'pull'` → 以下を実行。
- pull チャネル処理:
  1. `config.service_code` 必須。無ければ misconfig として **error** 結果 (adapter 不在と同様、握り潰さない)。
  2. scope_key を `config[config.scope_key_field ?? 'scope_key']` から解決。
  3. `getCredential(service_code, scopeKey)` を呼ぶ。
     - `CredentialFetchError.status === 404` (キー未投入) → **graceful skip** (`skip_no_credential` ログ、error 扱いにしない)。← キー投入後はコード変更ゼロで次 tick から受信開始。
     - その他のエラー (401/500/network) → channel error (再試行対象)。
  4. 解決した `credResp.credentials` を `ctx.credentials` に載せて adapter.fetchInbox 実行。
- アダプタは `ctx.credentials` を使う (service_code を知らない)。

rakuten アダプタ: `ctx.credentials` 消費に移行 (service_code ハードコード除去)。呼び出し元 `rakuten-sync` route で `config.service_code` (既定 `rakuten_rmesse`) を解決して ctx に渡す。挙動は不変。送信系 (outbound/send-first-response) は対象外・無変更。

### 3. yahoo Pull アダプタ (新規, subagent 実装)
- `src/channels/yahoo/{adapter,client,types}.ts`。
- `fetchInbox`: `externalTalkList` (poll, since→now, 1req/s 遵守の delay) → 各 talk を `externalTalkDetail` で本文取得 → NormalizedTicket/Message に正規化 → yield。
- 認証: `ctx.credentials` の OAuth Bearer access_token を使用 (Core 解決済を受領)。
- **[codex CONCERN#3 反映] トークン管理の責務契約:** Yahoo の access_token は有効期限を持つ。**Core `yahoo_shopping` credential が refresh/rotation 済みの有効な access_token を返す**ことを契約とする (Core 側の責務)。cs-manager は渡された token を使うのみで refresh しない。401 受領時は channel error (次 tick で再試行)。Core 側のトークン自動更新が未実装ならゲート項目 (Core 側作業) として記載し、cs-manager 実装はブロックしない。
- 共通 ingest 経由 (orchestrator が upsert)。

### 4. line Push webhook (新規, subagent 実装)
- 新 endpoint `POST /api/channels/line/inbound`。
- **[codex CONCERN#2 反映] channel/scope 解決 (署名検証前に body 加工しない):**
  1. raw body を**文字列のまま**読む (加工・JSON.parse しない)。
  2. DB から単一の active `line` channel (code='line', status='active') を1件取得し、その `config.scope_key` を読む (MVP=単一LINE運用前提)。複数LINE運用は将来拡張 (URL path/query の非秘密識別子で channel を引く) として明記、本実装はしない。
  3. `getCredential('line_messaging', scope_key)` で channel secret を取得 → **raw body に対し** HMAC-SHA256 を計算し `x-line-signature` と timing-safe 比較。
  4. 検証成功後に**初めて** body を JSON.parse する。
- 認可: secret 未投入時は 503 (設定待ち, 受信不可だが endpoint は存在 = キー投入後コード変更ゼロ)。署名不一致は 401。
- events[] の `type='message' && message.type='text'` を正規化 → 共通 ingest + RAG ドラフト。
- 冪等性: `message.id` を channel_message_id、`deliveryContext.isRedelivery` も考慮。再送でドラフト二重生成しない。
- 返信(push/reply) は**実装しない** (送信 OFF)。

### 5. 共通 ingest+draft の抽出 (DRY, push 経路共通化)
現 `ingestEmailInbound` の「upsertTicket → upsertMessageReturningNew → isNew なら generateRagReply → ticket_drafts 保存」ロジックを channel 非依存の `ingestInboundWithDraft(sb, {channelId, ticket, inboundMessage, ragInput})` に抽出 (`src/lib/sync/ingest-inbound.ts`)。
- email-ingest と line webhook が共用。
- PII 安全 (安定エラーコードのみ外部/ DB へ)・冪等・送信なし は現行同等を維持。
- email-ingest は宛先→inbox 解決後にこの共通関数を呼ぶだけに薄くする (挙動不変、回帰注意)。
- **[codex CONCERN#5 反映] 抽出前に email の外部契約をテストで固定:** 抽出リファクタの前に、現 `ingestEmailInbound` の (i) レスポンス status 値の集合, (ii) PII-safe `DraftErrorCode`, (iii) duplicate (同一 Message-ID) 挙動, (iv) `ticket.channel_meta.email_ingest` 形状 を pin する単体テストを先に追加。抽出後も同テストが green であることを回帰ゲートにする。

## 段階2 (workflow, 並列 subagent)
専用アダプタ判定された **yahoo(pull)** と **line(push)** を 2 subagent で並列実装 (担当ファイルが disjoint = 競合なし)。main は共通部分 (ctx 拡張・orchestrator credential gating・共通 ingest 抽出・migration・rakuten 是正) を先行 land し、安定 IF 上で fan-out。

## 段階3 検証
- E2E 4点 (POST200/DB行/GET/UI再描画): キーのある rakuten・email で本番疎通 green。
- 新アダプタ: parse/map unit + 共通 ingest 通しをモックで確認 (実キー未取得のため live 不可、明記)。
- 「キーを Core に入れたら受信開始 (コード変更ゼロ)」をモック credential を解決層に注入して実証 (getCredential の fetchImpl 差し替え)。
- grep: ハードコード key/secret 0件、独自 AI 呼び出し 0件。
- 送信が全チャネルで未呼出を確認。
- codex コードレビュー APPROVE。

## ゲート項目 (人間手動作業ブロック=止めずに記載)
- yahoo: Yahoo OAuth 利用申請+問い合わせツール権限取得 → Core `yahoo_shopping` credential に `access_token` と `seller_id`(ストアアカウント) を投入。アダプタは sellerId を credential から取得するため、これだけで稼働 (config.store_id 設定は単一店舗運用では不要)。token refresh は Core 責務。dateType/postUserType/postdate の値域は実レスポンスで最終突合。
  **go-live ゲート (codex コードレビュー指摘, yahoo active 化前に対応)**: externalTalkDetail 取得失敗時、現 MVP は headline.body を inbound にフォールバックして問い合わせ文+ドラフトは捕捉するが、orchestrator の wall-clock cursor の都合で detail 復旧後も full スレッド履歴/添付を再取得しない。実 API 挙動確認後に「topic 単位の取込状態管理 or server dateType 絞り込み」でハードニングする。
- line: LINE Developers でチャネル作成 → channel secret/access_token を Core `line_messaging` に投入。
  **go-live ゲート (codex コードレビュー指摘, line active 化前に対応)**: 現 MVP は 1 userId=1 ticket に束ね、
  共通 ingest は `done` ticket を再オープンしない。対応済 ticket への新着 LINE が inbox (created_at 順) で
  浮上しない懸念があるため、active 化前に「新着 inbound での再オープン or last_inbound_at 相当での並び替え」を
  入れる。受信・ドラフト生成自体は新着 message ごとに発生 (取りこぼしはしない)。
- amazon: 受信APIが存在しないため、問い合わせ通知メールの転送設定 (+送信したい場合のみ Buyer-Seller Messaging ロール承認)。
- aupay/qoo10: 公式受信API未確認。当面は問い合わせ通知メールを転送。API があると確認できれば pull アダプタ追加。
- own_ec: 問い合わせメール転送先 inbox を `channel_inboxes` に登録。

## 判定依頼
APPROVE / CONCERN / REJECT を明示してください。特に (a) credential-gated active + graceful-skip-on-404 の機構、(b) service_code を config 駆動にして ctx.credentials を orchestrator が注入する設計、(c) amazon/aupay/qoo10 を専用アダプタを作らずメール転送に倒す線引き、(d) 共通 ingest 抽出による email-ingest リファクタの回帰リスク、について。
