# 設計: LINE Webhook 転送受け口（Lステップ併用 L1 対応）

状態: **✅ codex 設計レビュー APPROVE 済（2026-07-23）＋ ✅ 実測で Case A 確定（2026-07-24）**
作成: 2026-07-23 / 更新: 2026-07-24 / フェーズ: `docs/roadmap.md` L1（併用開始）/ トム向け手順は `docs/lstep-line-migration-L1-tom-guide.md`
関連メモリ: `[[line-reply-send-wiring]]` `[[lstep-line-migration]]`

> ✅ **結論（2026-07-24 実測）: Case A = Lステップは `x-line-signature` を透過し、body も LINE 生 JSON のまま転送する。**
> → **受信認証のコード改修は不要**（既存 Tier1 の署名検証で受けられる）。**Tier2（転送元共有token）は実装しない**。
> 本書の §3 Tier2 / §10 コスト上限・喪失回収 は **Case B 用の未使用設計として保存**（将来 Lステップ仕様変更・他中継採用時の資産）。
> L1 の残作業は「cs-manager 側の受信配線（channel 有効化・Core への channel secret 投入）→ 転送先URLを本番に向けて実証 → go-live 判断」。

---

## 1. 背景・前提・唯一の未知点

L1 併用期間は、LINE 公式アカウントの Webhook を Lステップが保持したまま、Lステップの「Webhook転送機能」で受信データを cs-manager `POST /api/channels/line/inbound` へコピー転送してもらう。

現行の受信口は **`x-line-signature` の HMAC 検証のみ**で認可（`app/api/channels/line/inbound/route.ts:117-120`、`src/channels/line/verify.ts`）:

```
x-line-signature == Base64( HMAC-SHA256( rawBody, OA_channel_secret ) )
```
- channel secret は Core `/api/credentials/line_messaging` 取得（ハードコード禁止）。
- **署名検証が通るまで body を parse しない**（JSON.parse は検証後）。

### 1.1 Lステップ「Webhook転送機能」— ✅ **実測で Case A 確定（2026-07-24）**

**実測方法**: 転送先に一時的な捕捉エンドポイント（webhook.site）を設定し、LINE公式アカウントへ「テスト」1通を送信。届いた生リクエストのヘッダ/ボディを直接確認（確認後、転送先URLは即空にして復旧済）。

**結果 = Case A（署名そのまま透過・改修ゼロで受信可）**:
| 観測項目 | 実測値 | 判定 |
|---|---|---|
| HTTP method | `POST` | 想定どおり |
| `x-line-signature` | **有り**（`HCx6EB…` 28文字以上のBase64） | ✅ **透過** |
| `content-type` | `application/json;charset=UTF-8` | ✅ |
| `content-length` | `800` | ✅ 封筒化なし |
| body | `{"destination":"U57e…","events":[{"type":"message","message":{"type":"text","id":"624229537432994107","quoteToken":…,"markAsReadToken":…,"text":"テスト"},"webhookEventId":"01KYA6AV3MBP8V8ZGG9JN6NYD8","deliveryContext":{…}}]}` | ✅ **LINE生JSONそのまま**（独自ラップ無し） |
| 転送元 | IP `18.176.142.158`（東京）/ `user-agent: GuzzleHttp/7` | 参考（IP allowlist の候補） |

- **Q1（バイト忠実性）**: body は LINE 生 JSON 構造そのまま。**署名検証の成立可否は本番受信時に最終確認**（署名は受信 body から都度再計算する現行 verify.ts 方式なので、透過している以上は成立する見込み）。
- **Q2（署名透過）**: ✅ **透過する**。→ **Tier1（既存の署名検証）だけで受けられる＝コード改修ゼロ**。
- **Q3（カスタムヘッダ欄）**: ❌ **無い**。管理画面「アカウント設定 > 外部連携設定 > LINE Webhook転送設定」の設定項目は **転送先URL 1欄 + 「設定を保存」のみ**（イベント選択チェックも無し）。→ **Tier2 のヘッダ token 方式は実際に不可**。ただし Case A 確定により **Tier2 自体が不要**。
- **Q4（リトライ/タイムアウト）**: 未確認（実運用で観測する。現行は冪等 ingest があるため重複は無害）。
- **版の確定**: 「+ API連携」11,000円版は**逆向き**の機能（外部→Lステップの書き戻し）で本移行には不要。**5,500円版のみで足りることを確認済**。
- **申込**: 即時課金・即時利用可（「約3営業日承認」は該当せず）。
- ⚠️ 旧記載の「Lステップ転送で署名が壊れる」説は**誤り**であったことが実測で確定（検索エンジンの推測合成だった）。

### 1.2 LINE 公式仕様（裏取り済み・confidence: high）
1. 署名は **raw request body に対する HMAC-SHA256 → Base64**。LINE 明記: parse/再シリアライズ/escaping 等**いかなる改変**でも検証は失敗。→ 中継が body を1バイト変えると Case A 不成立。
2. Webhook は **1チャネル1エンドポイント**。LINE は転送/プロキシを**提供も禁止もしない**（サードパーティ機能）。
3. 再送 (`deliveryContext.isRedelivery=true`) は本文がフラグ分**変わる**→署名も変わる。**受信 body から都度再計算する実装は安全**（現行 verify.ts）。元署名文字列のキャッシュ比較は不可。再送は**受信側が2xxを返さない時のみ**発火（LINE設定・既定OFF）。回数/間隔は非公開。
4. 冪等キーの LINE 推奨は `webhookEventId`(ULID)。現行 ingest は `channel_message_id`(=message.id) で dedupe（message event のみ id を持つ）。

### 1.3 LINE が示す中継の定石（本設計の根拠）
安全策は **「raw body が無傷な最初のホップ（=Lステップ）で署名検証し、下流（=cs-manager）へは信頼できる内部信号を渡す」**。すなわち **Case B（転送元用の共有token で受ける）こそ本来堅牢**であり、Case A（署名素通し）は「たまたま成立するが1バイト改変で崩れる脆い経路」。ただし §1.1 の訂正どおり **A/B は実測で確定**する。

---

## 2. 転送時の振る舞い整理（現行コードのまま）

> ✅ **実測結果（2026-07-24）: 該当は「A 素通し」**。以下 B-1〜B-4 は**発生しなかった**（未使用設計として保存）。

| ケース | Lステップの転送挙動 | 現行受け口の結果 | 対応 |
|---|---|---|---|
| **✅ A 素通し（実測で該当）** | raw body バイト一致 **かつ** `x-line-signature` 無改変付与 | Tier1 検証**成立 → 200**（同 OA channel secret を Core 取得済み前提） | **改修ゼロ** |
| **B-1 body再構成** | JSON 再シリアライズ（空白/キー順/文字コード差） | 署名不一致 → **401**（正当転送を取りこぼす） | Tier2 共有token |
| **B-2 署名欠落** | `x-line-signature` を付けない | `signature=null` → **401** | Tier2 共有token |
| **B-3 ヘッダ改名/gzip** | 別ヘッダ名 or 署名後に body を再圧縮/改変 | 署名取得不可 or 本文が別バイトで不一致 → **401** | Tier2(署名では回復不可) |
| **B-4 封筒化** | Lステップ独自 JSON でラップ | 署名 & `events` 構造不一致 → **401** | **本設計対象外（§8）別レビュー** |

> ヘッダ名の大小: `req.headers.get()` は case-insensitive（`X-Line-Signature` でも取れる）。別名の B-3 は取得不可。

---

## 3. 設計（追加的・可逆・opt-in）— 同一エンドポイント内の段階認証

parse 前に次の順で認可。**既存署名経路は一切変えない**（L5 直結の最終形）。

```
POST /api/channels/line/inbound
  ├ 0. raw body を await req.arrayBuffer() で取得（バイトのまま。UTF-8 往復しない）
  │     size guard は Buffer 実バイト長で判定（Content-Length は信用しきらない）
  ├ 1. active な line channel を server-side で解決（現行 maybeSingle。request 由来入力で選ばない）
  │     config.forward_mode / forward_until はこの server 解決 channel からのみ読む
  ├ 2. Tier1: x-line-signature を OA channel secret で検証（HMAC は arrayBuffer の Buffer に対して計算）
  │     - forward_mode=false: channel secret 取得失敗は現行どおり 503
  │     - forward_mode=true : channel secret が無い/取得失敗なら Tier1 を「利用不可→skip」扱いにし Tier2 へ落ちる
  │       （Case B では OA secret が無いこともある。ここで 503 早期returnしない）
  │     成立 → 認可OK（auth_tier='line_signature'）
  ├ 3. Tier2（forward_mode=true かつ now<forward_until のときだけ評価。既定=無効）:
  │     - まず forward token を Core から取得。空/空白/取得失敗なら timingSafeEqual 前に 503（fail-closed。空同士一致を絶対に作らない）
  │     - 受信 token をヘッダから取得（query は不採用）:
  │         第一候補 Authorization: Bearer <token>（api-contract 準拠）
  │         例外契約 X-CS-Forward-Token: <token>（Lステップが Authorization 不可の時のみ・本書と AGENTS.md に明記）
  │     - constant-time 比較（長さ事前チェック→timingSafeEqual）。受信値は trim せず厳密比較（正規化は Core 投入時のみ）
  │     一致 → 認可OK（auth_tier='forward_token'）
  ├ 4. どちらも認可不可 → 401 / 両 tier とも「利用不可（未投入）」→ 503
  ├ 4.5 診断ログ（DIAG_TOKEN gate 時のみ・PII/token/署名値は出さない）:
  │     {signature_present:bool, received_byte_len, computed_vs_received_len_delta, auth_tier, forward_mode}
  │     → L1 実測で Case A/B・gzip・改変を切り分ける（§7）
  └ 5. 認可OK後に初めて JSON.parse → 正規化 → 冪等 ingest（現行のまま）
       Tier2 経路は 1リクエストあたり処理イベント数に上限、かつ channel 単位レート制限（§3.2 コスト）
```

### 3.1 各点の要件
- **forward_mode + 期限 fail-closed**: Tier2 は `config.forward_mode===true` **かつ** `now < config.forward_until`(ISO8601, サーバ検証) のときのみ。期限超過・欠落は Tier2 を**閉じる**。→ 「L1 後に OFF し忘れて transport-only が恒久化」を仕組みで防止。診断口 `/api/diag` に「forward_mode=true の active line channel を検知したら警告」を足す（恒久残存の検知）。
- **Tier1 優先だが Tier2 と独立に評価可**: forward_mode 中でも署名が通れば Case A として full crypto を優先。ただし Tier1 secret 不在で Tier2 を巻き添え 503 にしない（上記フロー step2）。
- **token の出所（B案 SSoT）**: Core credentials 新規キー `line_webhook_forward.token`。実行時取得・**env/ハードコード禁止**・≥32byte CSPRNG。
  - **fetch allowlist**: line channel の `ALLOWED_LINE_SERVICE_CODES` とは別経路。forward token 取得先 service_code を **cs-manager 側 allowlist に追加**する必要（config 改竄で別 Vault 鍵を引かせない多層防御。実装時に確認）。
  - **Core 登録責任/scope**: `line_webhook_forward` の Core 登録（値投入）は運用/トム物理作業。`scope_key` は**既存 LINE channel と同じ店舗/チャネル境界**を適用。Core に該当エンドポイントが無ければ勝手に代替を作らず止めて報告（B案）。
  - **失効/キャッシュ**: `getCredential` は 5分 TTL。**認証 token は fetch 失敗時に stale fallback しない**（fail-closed）。失効反映は最大5分と明記。ローテーションは単一 token 即時切替（新旧重複期間を作らない）か切替手順を運用明記。
- **size guard（実バイト）**: `Buffer.byteLength`/arrayBuffer の実バイト長で 1MB 判定（`rawBody.length` の文字数判定は日本語で過少評価）。Tier2 で送信元が広がるため必須。
- **監査/可観測性**: `auth_tier`(`line_signature`|`forward_token`) と成功/失敗件数のみログ。**PII・token・不正署名値は出さない**。Tier1失敗→Tier2成功（意図的 signature downgrade）を tier で区別可能に。
- **status 意味論 & 喪失回収**: 認可失敗=401、両tier未投入=503。**部分失敗の具体契約（保存前失敗=503／保存後RAG失敗=200+state記録・本文非複製）は §10.2 で確定**。※ round1 の「認可後200が取りこぼしを防ぐ」は誤り＝200は再送を止め喪失を確定させる、を §10.2 で是正。
- **冪等（scope 明記）**: dedupe キーは `channel_message_id`(=message.id)。**message event のみ id を持つ**ため冪等保証は現状 text ingest に限る。L2+ で非 message event を扱う前に `webhookEventId`(ULID) 採用が前提。
- **単一 active line channel 前提（明記）**: `maybeSingle()` は「code=line & status=active が1件」を前提。direct(Tier1) と forwarded(forward_mode) の line channel を**同時に active にしない**。並行運用が必要になったら destination ベース lookup（既存 TODO）を先に入れる。

### 3.2 信頼モデル・残余リスク・コスト（明示合意）
Tier2 は **transport（送信元がLステップか）認証**であり **payload origin（本文が LINE 由来で無改変か）は暗号証明しない**。
- **受容根拠**: (a) forward_mode 明示opt-in・既定OFF・期限 fail-closed、(b) token ≥32byte CSPRNG・Core管理・stale不使用、(c) 認可後も body スキーマ検証・実バイト1MBガード・PII安全ログ・冪等 ingest 不変、(d) L5 で Tier1 のみへ復帰。
- **侵害時影響**: Lステップ本体/アカウント/転送設定/token のいずれか侵害で、攻撃者は任意の本文・userId・message.id を注入し RAG・下書き生成まで発火し得る。→ L1限定リスク受容 + **期限fail-closed + 認証失敗監視**を設計条件に。
- **コスト増幅/DoS（cost発生＝トム確認事項）**: Tier2 の各イベントは **origin-ai RAG 下書き（課金AI呼出）** + DB 書込を発火。token 漏洩で **青天井の origin-ai 費用**になり得る。**分散安全な具体上限（共有原子ストア・課金前の原子的予算消費・超過時は本文保存/下書きdefer）は §10.1 で確定**（プロセス内カウンタは Vercel 複数インスタンスで保証できないため不可）。
- **リプレイ残余**: Tier2 は暗号的リプレイ防止なし。既存 dedupe は同一 message.id の二重下書きのみ抑止。認証試行負荷・malformed・別ID偽造は防げない。Lステップが元 `x-line-signature`/timestamp を渡すなら検証優先（＝実質 Tier1）。無い場合は実バイト size 制限・レート制限・監視で縛る。
- **多層防御（可能なら）**: Lステップが**安定した egress IP** を公開しているなら、転送口を当該 IP レンジに制限（token 単一障害点化の緩和）。公開有無は申込後に確認（不明なら採用しない）。

---

## 4. スコープと非スコープ

**含む（実装は Case 確定後）**
- Tier2 共有token 経路（forward_mode+forward_until, ヘッダのみ, 空token fail-closed, tier独立評価, レート/件数上限）。**Case B のときのみ実装**。
- HMAC を arrayBuffer バイトに対して計算 + 実バイト size guard + 診断ログ（Case A/B 切り分け）。**Case A でも適用してよい additive 堅牢化**（文字列往復による取りこぼしを防ぎ、実測診断を可能にする。※中継が署名後に body を再圧縮/改変した場合はバイト HMAC でも Tier1 は回復できない＝それは Tier2 で受ける Case B。「gzip 耐性」ではない点に注意）。
- Core 新規 credential `line_webhook_forward.token`（additive。値投入は物理作業）+ fetch allowlist 追加。
- 送信オフの構造ガード（§5）。

**含まない（勝手に作らない・別レビュー）**
- **B-4 封筒剥がし正規化**（§8）。
- URL query/path 埋め込み token（露出リスクで不採用。Lステップが URL しか設定できないと実測確定した場合のみ、別途リスク受容レビュー）。
- 複数 LINE チャネル同時 active / 会話単位束ね（既存 TODO のまま）。

**Case A のときは受信認証コードはゼロ**（診断ログ・バイト HMAC・size guard 堅牢化のみ任意先行）。

---

## 5. L1 二重返信ガード（構造ガードを主・運用を副）＆ L5 復帰条件
roadmap L1 は「返信は当面Lステップ・cs-managerは閲覧+下書きのみ・二重返信防止」。
- **構造ガード（主・additive・既定安全）**: `line-sync`/`outbound` は **`config.forward_mode===true` の channel を送信 skip**（または専用 `send_enabled=false` gate。既定送信可・forward_mode 時のみ停止）。承認クリック運用に依存せず、token 漏洩で偽造下書きが承認されても**自動送信されない**。既に forward_mode を足すので追加コスト極小。→ 敵対レビュー3観点が独立指摘。
- **運用ガード（副）**: L1 中は下書きを承認しない。
- **L5 復帰（Tier2 撤去の完了条件）**: (1) `forward_mode=false` を確認（送信解除は forward_until 超過ではなく **forward_mode=false のみ**・§10.3）、(2) **Tier2 拒否テスト**（forward token 付きが 401）、(3) Core `line_webhook_forward.token` を**削除**（停止参照だけでなく失効）+ キャッシュ失効確認、(4) LINE Webhook を cs-manager 直結へ repoint 確認、(5) 送信 skip gate 解除。L5 goal の完了条件に含める。

---

## 6. 破壊的変更の有無（共有物チェック）
- 既存 LINE 直結署名経路（Tier1）: **無変更**。L5 でもそのまま。→ 破壊的変更なし。
- 追加物: config `forward_mode`/`forward_until`（新キー・既定無効）、Core credential `line_webhook_forward`（新キー）、fetch allowlist 追加、size guard 実バイト化、送信 skip gate（既定=従来動作）、診断ログ。すべて **additive**。他ツールが今使う共有テーブル/APIの欄削除・改名・型変更は**しない**。→ 共有物の破壊的変更に**非該当**。
- 課金/go-live（オプション申込・受信ON・token 投入）は**トム物理作業**（別チェックリスト）。

## 7. L1 実測手順（Case A/B 判定＝この設計の分岐点）
1. トムが転送オプション申込→承認(約3営業日)→転送先URLに `/api/channels/line/inbound` を設定→転送ON。
2. テスト1通送信。診断ログ(§3 step4.5, DIAG_TOKEN gate)で **署名の有無・受信バイト長・computed/received 長差・content-encoding** を確認。
3. 判定:
   - 署名あり & バイト一致で HMAC 成立 → **Case A**（受信認証は改修ゼロ。診断/バイトHMAC堅牢化のみ任意）。
   - 署名欠落/不一致/gzip/別ヘッダ → **Case B**。§3 Tier2 を実装。
   - 独自封筒 → **B-4**（§8 別レビューへ）。
4. 並行で Q3(カスタムヘッダ可否)・Q4(再送/タイムアウト)を実測 or Lステップサポート確認 → Tier2 のヘッダ方式と status 意味論を確定。

## 8. B-4（封筒化）— 別設計レビュー（本書では設計しない）
封筒剥がし後に**何を信頼するか**未定義（channel/destination/message.id の無条件信頼はチャネル混同・任意ID注入源）。実データで封筒構造確認の上、別レビューで固定: 厳密 schema・許可フィールド・元イベント抽出位置・destination 照合・冪等キーは**確認済みの元 LINE `message.id`（Lステップ独自転送IDは不可）**・上限件数。認証は**必ずヘッダ token で先に**行い、その後に封筒 parse（parse-before-auth を破らない）。

## 9. PII の扱い（明確化）
「PII 非保存」は**現行 ingest 設計を変えない**の意。現行は本文 `messages.body`・userId `tickets.channel_meta.userId`（RLS=service_role 限定）へ正規に保存し、これは維持。本設計の不変条件は **「転送認証対応で新規・副次的な PII 保存先を増やさない／ログ・エラーに PII・token・署名値を出さない」**。

## 10. コスト上限・喪失回収・細部の確定契約（codex round2 Major反映）

### 11.1 コスト上限（分散安全・Case B 実装時）
- **共有原子ストア**: cs-manager ローカル Postgres（**業務データ**＝マスタでない、B案OK）。新テーブル `forward_rate_states(channel_id, window_start, ingest_count, rag_count)`、UNIQUE(channel_id, window_start)。保持は直近N日、掃除は軽量 sweep（or 既存 cron 相乗り）。プロセス内カウンタは Vercel 複数インスタンスで保証不可のため**採らない**。
- **設定値（env 駆動・ハードコード禁止・既定値）**: `FORWARD_MAX_EVENTS_PER_REQUEST`(DoS 上限・既定100)、`FORWARD_INGEST_ALERT_PER_WINDOW`(channel×窓・既定60/時)、`FORWARD_RAG_MAX_PER_WINDOW`(channel×窓・既定30/時)。
- **喪失回収と両立する hard cap は「RAG 予算」だけ**（§10.2「問い合わせ喪失不可」との矛盾を断つ）:
  - **RAG 予算（唯一の hard cap・原子的）**: origin-ai 呼出の**前に** Postgres RPC（window 行を UPSERT+increment、cap 超なら false。既存 `claim_fba_return_classify_batch` と同型）で原子的に消費。超過時は **inbound message を必ず保存**した上で RAG 下書きだけ skip し `draft_deferred` で記録 → HTTP **200**（本文は保存済＝喪失なし・後で reprocess §10.4）。**課金される RAG のみを絞る**。
  - **ingest カウント = アラート閾値（drop しない）**: `FORWARD_INGEST_ALERT_PER_WINDOW` 超過は監視/警告のみで**メッセージは常に保存**。→「常に保存」と「上限」を両立（ingest は hard cap にしない）。
  - **events/リクエスト = DoS 上限**: `events.length > FORWARD_MAX_EVENTS_PER_REQUEST` は **1件も処理せず 503**（`{ ok:false, error }` 形式。部分保存+200 の silent drop は禁止）。既定100は正当traffic が触れない高さ。加えて実バイト1MBガードが総イベント量を bound。
- **L1 はキュー化しない**（1:1 text・低volume。同期上限で十分）。volume 増でキュー化・予算上限は backlog（現時点は不採用を明記）。

### 11.2 喪失/回収契約（部分失敗・provisional は Q4 実測で確定）
- **保存順**: ticket/message を先に耐久保存（現行 `upsertTicket`→`upsertMessageReturningNew` は既に RAG 前）→ その後 RAG。
- **保存前失敗**（DB down 等でメッセージ永続化に失敗）→ **503**（両 tier 共通・上流 redeliver 前提。既存 `(ticket_id,channel_message_id)` UNIQUE で重複吸収）。※現行は署名OK後の ingest 失敗を 200 にしているが、**保存前失敗は 503 へ是正**（additive な取りこぼし修正・両 path 適用・テストで pin）。
- **保存後の RAG 失敗**（message は保存済＝喪失なし）→ **200**。記録は `{ticket_id, message_id/webhookEventId, 非PIIエラー種別, state=draft_failed|draft_deferred}` のみで **本文を複製しない**（新規 PII sink を作らない。本文は既存 `messages.body` にある）。名称は `processing_failure`/reprocess であり **dead-letter ではない**。
- webhook 全体を 1 event の RAG 失敗で 503 にしない（正常 event の再送増幅を防ぐ）。per-event: 正常=処理、RAG失敗=state記録、全体は保存済のため 200。
- **再処理**: 軽量 retry（cron or 手動）が下書き未生成(deferred/failed)の ticket を**既存 messages から読み**再 RAG（新規 sink なし）。
- **Q4 依存**: 保存前失敗の 503 が Lステップ再送で有効に効くかは Q4（再送有無/回数/タイムアウト）実測後に確定。

### 11.3 細部の確定
- **Authorization present-but-invalid → 401**（X-CS-Forward-Token へ **fallback しない**。Authorization が存在すればそれを正とする）。
- **forward_until 超過後も `forward_mode=true` の間は送信 skip を維持**。送信解除は明示的 `forward_mode=false` のみ（fail-safe 統一）。
- **forward token の `scope_key` は非空・期待形式必須**（任意/空を許さない）。

### 11.4 再処理の耐久スキーマと原子的 claim（§10.2 の保存後失敗を回収）
既存 `ticket_drafts` は「下書きが無い失敗」を表現できず、`ingestInboundWithDraft` は `ticketId` しか返さないため、再処理対象を冪等に特定できない。新テーブルで確定する:
- **`upsertMessageReturningNew` の契約拡張**: 保存済み **message id を返す**（現行は isNew のみ）。§10.2/11.4 は message 単位で失敗を紐付けるため必須。additive。
- **新テーブル `processing_failures`**（自ツール業務データ・additive・**本文を持たない=新規 PII sink なし**）:
  - `message_id` NOT NULL FK(messages.id)、`kind`(例 `rag_draft`)、`state`(`draft_deferred`|`processing`|`draft_failed`|`resolved`|`dead`)、`error_code`(非PII)、`attempts`、`next_attempt_at`、`claimed_at`、`created_at`/`updated_at`。
  - **UNIQUE(`message_id`, `kind`)**（同一失敗を二重登録しない）。
- **保存と登録の原子化（outbox・孤児 message 防止）**: **新規 message の保存と `processing_failures(message_id,'rag_draft',state='draft_deferred')` の作成を同一トランザクション/RPC で行う**。→ message 保存後・failure 登録前のクラッシュで「下書き未生成が耐久記録されない孤児 message」を作らない。以後、**同期処理も再処理も同じ原子 claim 経路を通る**。
- **重複 message（isNew=false）**: 既存 message id と既存 `processing_failures` state を返す契約。RAG を再実行せず行も重複しない（UNIQUE が担保）。
- **再処理 claim（原子的・lease 付き RPC）**: `state in (draft_deferred,draft_failed) AND next_attempt_at<=now()` を lease で原子的に掴み `processing` へ（既存 `claim_fba_return_classify_batch` と同型）。RAG を呼ぶのは **§10.1 の RAG 予算 claim を消費した後**（二重課金防止）。同期経路も同じく `draft_deferred→(予算claim)→processing→RAG` を通る。
- **状態遷移**: 初期 `draft_deferred` → 予算claim後 `processing` → 成功 `resolved`（下書き保存済）／失敗 `draft_failed`（`attempts++`・`next_attempt_at` 指数バックオフ）／予算超過は `draft_deferred` のまま（reprocess が拾う）／上限到達→終端 `dead`（アラート）。
- 本文は常に既存 `messages.body` を読む（複製しない）。

> `forward_rate_states` / `processing_failures` は cs-manager 自ツール業務データの新規テーブル（additive）。§6 の非破壊判定に含める（他ツール共有物ではない）。エラー応答は既存規約どおり `{ ok:false, error:string }` を維持。

## 11. codex 設計レビュー観点（依頼）
1. parse-before-auth 維持（Tier2 はヘッダのみ・token一致後に初めて parse。診断ログも parse 前は署名有無/長さのみ）。
2. forward_mode+forward_until fail-closed & 送信 skip gate（§10.3 の解除契約含む）で恒久弱体化・二重返信・偽造自動送信を防げるか。
3. 空token fail-closed / tier独立評価 / ヘッダのみ(query廃止, §10.3 fallback契約) / constant-time・厳密比較。
4. **§10.1 の分散安全なコスト上限**（共有原子ストア・課金前消費・超過時 defer）で cost発生リスクを許容範囲に抑えられるか。
5. **§10.2 の喪失回収契約**（保存前503/保存後200・本文非複製）が「問い合わせ喪失許容不可」と「新規PII sink無し」を両立できているか。
6. B案SSoT・追加的可逆・共有物非破壊（`forward_rate_states` 含む）の整合、B-4 隔離。
