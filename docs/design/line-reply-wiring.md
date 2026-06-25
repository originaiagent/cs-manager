# LINE 返信配線 設計 (受信→AI下書き→承認→実返信送信)

ゴール: 楽天 R-MessE で本番稼働している「受信→承認→送信」の土台を LINE に展開し、
LINE Messaging API への実返信送信まで結線する。全AI=origin-ai 経由 / マスタ・認証=origin-core 経由 /
鍵ハードコード禁止 (B案 / AI集約原則)。

調査日: 2026-06-25 / 対象: cs-manager (DB `jpnsoqzzylahpandbfcz`) + origin-core (DB `fqzsxjhhdzrliuuooqic`)

---

## 0. 結論サマリ (先に読む)

- **受信→下書きは既に完成・本番品質**。cs-manager が自前の LINE 受信 webhook
  `POST /api/channels/line/inbound` を持ち、署名検証→正規化→共通ingest→origin-ai embed
  (`cs-reply:draft`)→`ticket_drafts(source='rag', status='pending')` まで通っている。**段階2 task B は実装不要 (既存再利用)**。
- **送信は未実装**。`src/channels/line/` は `normalize.ts` / `verify.ts` のみ。送信アダプタ・
  approved→送信トリガが無い。→ **段階2 の本体は task C (送信アダプタ) + task D (送信cron) の新規実装**。
- **【重大・要トム判断】タスク前提の「origin-core /api/messages/webhook/line が受信し cs-manager に受け渡す」は実態と異なる。**
  origin-core の同 webhook は **origin-core 内で完結する別個の CS パイプライン** (自前 `messages` テーブル +
  origin-core 内製 AI による autoReply/replyEngine + 自前 Push 送信) で、**cs-manager へは一切受け渡さない**。
  しかも origin-core 内製 AI 経路は **B案 (AI=origin-ai集約) に違反**する。
  → **段階2 task A (origin-core webhook の受け渡し実装) は不要。むしろ作ると経路二重化の場当たり対応**になる。
  正しい配線は **LINE Developers の Webhook URL を cs-manager に直接向ける**こと (§6)。
- **【重大・要トム作業】認証情報未投入 + 設定不整合**:
  - Core `external_service_credentials` に `line_messaging` の行が **0件** (channel_access_token / channel_secret 未投入)。
  - Core 定義は `scope_key_required = true` (Channel ID 必須) だが、cs-manager の `channels(code=line).config` に
    `scope_key` が **無い**。このままだと受信署名検証も送信も credential 解決で **404→503** になる (§5)。

---

## 1. 楽天との差分 (1枚)

| 観点 | 楽天 R-MessE (参照モデル・稼働中) | LINE (本設計) | 差分の要点 |
|---|---|---|---|
| 受信方式 | pull (cron が API ポーリング) | **push (webhook)** | pull adapter 無し。registry 非登録。受信は webhook route が担う |
| 受信実装 | `rakuten/adapter.ts` `fetchInbox` | `app/api/channels/line/inbound/route.ts` (**実装済**) | 既に署名検証→ingest 完成 |
| 署名検証 | 無 (ESA 認証ヘッダのみ) | **HMAC-SHA256(rawBody, channel_secret)→Base64, timing-safe** (`line/verify.ts` 実装済) | raw body を加工前に検証 |
| 認証取得 | `getCredential('rakuten_rmesse', shop_id)` → `ESA <base64(secret:key)>` | `getCredential('line_messaging', <Channel ID>)` → `Bearer <channel_access_token>` | scope_key=Channel ID。送信は Bearer |
| 宛先解決 | `ticket.external_id` = inquiryNumber | **`ticket.channel_meta.userId`** (Push の `to`) | LINE は会話相手 userId に push |
| 送信 API | `POST /inquiry/reply` | `POST https://api.line.me/v2/bot/message/push` | reply token は承認遅延で失効 → **push 一択** |
| 送信レスポンスのID | 無 → 直後 GET で reply.id 特定 | `sentMessages[].id` or `X-Line-Request-Id` ヘッダ | LINE はヘッダ/簡易body。後追いGET不要 |
| 二重送信防止 | POST成功直後 `status='sent'`+`sent_at`+暫定`external_message_id` | **同方式** + 送信時に `X-Line-Retry-Key` で LINE 側冪等も付与 | 楽天踏襲 + LINE固有の retry key 追加 |
| 下書き生成 | 共通 `ingestInboundWithDraft` → origin-ai embed | **同一**(既存共用) | 差分なし。LINE も同じ共通経路 |
| 承認 | UI で `ticket_drafts.status='approved'` | **同一**(既存共用) | 差分なし |
| 送信トリガ | `/api/cron/rakuten-sync` (5分, 受信+送信) | **`/api/cron/line-sync` (送信のみ)** 新規 | LINE は pull 受信が無いので送信専用 cron |
| 送信安全フィルタ | `SEND_SAFE_OR_FILTER` (manual / (ai_draft|rag & is_separated)) | **同一を再利用** | first_response を sweep に載せない含め踏襲 |
| 送信上限/RL | 20件/run, 200ms間隔, 429 backoff | 同方式 (LINE push は寛容だが踏襲) | パリティ維持 |

---

## 2. 実態マップ (実コード根拠)

### 2.1 origin-core `/api/messages/webhook/line` — 受け渡し **無し** (別系統)
- 実装: `origin-core/server/messages/webhooks.ts:70-147` (route: `server/routes/messages.ts:35`)。
- HMAC-SHA256 を `message_channels.config.channel_secret` (origin-core 自前テーブル) で検証。
- 保存先は **origin-core 自前 `messages` テーブル**。後続は origin-core 内製の
  `autoReply` / `extraction` / `replyEngine`(内製AI下書き) / `automations` を fire-and-forget。
- 送信は `server/messages/sender.ts:124` が **LINE Push API を `channel_access_token` で**自前実行。
- **cs-manager への転送・参照は皆無**。`/api/messages/reply` も origin-core 自前送信。
- 評価: これは origin-core の独立した「メッセージHub」機能。**cs-manager のゴール経路ではない**し、
  内製AIは **B案違反**。→ ここに cs-manager 連携を足す = 経路二重化の場当たり対応。**採らない**。

### 2.2 cs-manager 受信→下書き — **完成**
- `app/api/channels/line/inbound/route.ts:54-161`:
  raw body 読取 → `channels(code=line, status=active)` 解決 → `getCredential(service_code, config.scope_key ?? null)`
  で channel_secret 取得 → `verifyLineSignature` → 検証後 JSON.parse → text event を
  `normalizeLineTextEvent` → `ingestInboundWithDraft`。署名OK後は常に200 (LINE再送ループ防止)。
- `src/channels/line/verify.ts:26-49` 署名検証 (timing-safe, 32byte長チェック, throwしない)。
- `src/channels/line/normalize.ts:71-116` 正規化。**`externalId = userId ?? message.id`**、
  `channelMeta.userId` に PII の userId を保持、`channelMessageId = line:<message.id>`。
- 共通 ingest: `src/lib/sync/ingest-inbound.ts:72-128` (冪等 upsert + 新規時 RAG + fail-closed)。
  RAG: `src/lib/rag/reply-adapter.ts` → embed `cs-reply:draft` (`run-oneshot.ts`, `EMBED_CLIENT_KEY`/`ORIGIN_AI_BASE_URL`)。

### 2.3 送信 (Messaging API) — **未実装**
- `src/channels/line/` に `outbound.ts` / `client.ts` / `auth.ts` / `types.ts` **無し**。
- registry (`_lib/registry.ts`) は rakuten / yahoo のみ。`vercel.json` crons は sync-channels / rakuten-sync のみ。

### 2.4 承認→送信トリガ — **未実装** (承認 UI 自体は ticket_drafts 共用で既存)

### 2.5 楽天送信モデル (踏襲対象, `rakuten/outbound.ts` + `cron/rakuten-sync`)
- `loadApprovedDrafts`: `ticket_drafts status='approved'` ∧ `ticket.channel_id=<ch>` ∧ `SEND_SAFE_OR_FILTER`, 最大20, created_at昇順。
- 送信ループ: `sendReplyWithBackoff` (429 backoff) → **POST成功直後** `markDraftSent(status=sent, sent_at, 暫定external_message_id)`
  → `upsertOutboundMessage(messages)` → 本物ID解決 (失敗許容) → 200ms sleep。
- cron: `authorizeApiRoute(req,{tier:'cron'})` → active channels loop → inbound+outbound → 207/200/500。`POST=GET`。

---

## 3. 推奨設計 (段階2 で作るもの)

### 3.1 ファイル構成 (`src/channels/line/` に追加)
```
src/channels/line/
  verify.ts        # 既存 (受信署名検証)
  normalize.ts     # 既存 (受信正規化)
  auth.ts          # 新規: buildLineAuthHeader(creds) -> "Bearer <channel_access_token>" + LineCredentials型
  client.ts        # 新規: LineMessagingClient.pushMessage({to, text, retryKey})  Push API ラッパ
  types.ts         # 新規: LinePushRequest/Response, LineApiError
  outbound.ts      # 新規: sendApprovedLineDrafts(channel, logger) -> OutboundResult (楽天 outbound.ts と同型)
```

### 3.2 送信アダプタ `sendApprovedLineDrafts` (楽天 outbound.ts を雛形 + codex CONCERN 2点反映)

> codex (2026-06-25) CONCERN: (a) userId欠落・恒久4xx を approved 維持にすると無限再送 → **非リトライ terminal 状態へ落とす**。
> (b) cron 重複実行で同一 approved draft の同時送信を防ぐ **排他 (atomic claim)** を入れる。両方を以下に織り込む。

**状態遷移** (新 status: `sending`=送信中claim, `failed`=非リトライ恒久失敗。§3.5 でマイグレーション):
```
approved --(atomic claim)--> sending --2xx--> sent
                                       |--transient(429/5xx/network)--> approved (last_error記録, 次cronで再送)
                                       |--permanent(4xx≠429 / userId欠落)--> failed (last_error記録, 再送しない)
```

1. `cfg = channel.config`。`scopeKey = cfg.scope_key`(= Channel ID)。`serviceCode = cfg.service_code ?? 'line_messaging'` を
   **allowlist (`line_messaging` のみ) 検証** (受信 route と同じ多層防御)。
2. `getCredential<LineCredential>(serviceCode, scopeKey ?? null)` → `channel_access_token`。client 構築。
3. **stale 再回収** (起動時, retry-key 重複防止窓=24h を踏まえ 2 段。codex R2 #3):
   - `15min < 経過 ≤ 24h` の `sending`: `status='approved'` に戻す (再送可。retry-key が二重着信を防ぐ)。
   - `経過 > 24h` の `sending`: `status='failed'` + last_error='line: sending stale >24h (retry-key expired)'
     (retry-key 失効後の自動再送は二重配信リスク → 再送せず手動レビュー)。
4. **候補抽出**: `ticket_drafts.select('id, ticket_id, ticket:tickets!inner(id, external_id, channel_id, channel_meta)')`
   `.eq('status','approved').eq('ticket.channel_id', ch).or(SEND_SAFE_OR_FILTER).order(created_at).limit(20)` で id を取得。
   **`SEND_SAFE_OR_FILTER` は rakuten/outbound.ts から共有 import** (重複定義しない)。
5. **atomic claim (排他)**: `update ticket_drafts set status='sending', updated_at=now() where id in (候補ids) and status='approved'`
   を `.select('id, body, ticket_id, ticket:tickets!inner(id, external_id, channel_id, channel_meta)')` 付きで実行。
   **`status='approved'` ガードが排他の本体** — 並行 cron が先に claim した行は `approved` でなくなり update に match せず返らない。
   返ってきた (=自分が claim した) 行のみ送信対象。
   (PostgREST update-returning が embed 非対応の環境向けフォールバック: claim は flat 行を返し、ticket 情報は ticket_id で別途 select。)
6. 各 claimed draft:
   - **宛先解決**: `to = ticket.channel_meta.userId`。妥当な userId (例 `U` 始まり) が無ければ
     **`status='failed'` + last_error='line: no userId to push'** (group/room 等は push 不能 = 恒久失敗。誤爆 push 防止)。
   - `retryKey = uuidv5(draftId, 固定namespace)` (決定的) を `X-Line-Retry-Key` に付与 → LINE 側でも冪等
     (claim 後クラッシュ→stale 再回収→再送、でも LINE は同一 retryKey を重複配信しない)。
   - `pushMessage({to, text: body, retryKey})` を送信。client は status・error body・`x-line-request-id` を返す。
   - **成功扱い (2xx または 409)** → `markDraftSent(draftId, externalMessageId, sentAt)` で `status='sent'`:
     - 2xx: `externalMessageId = sentMessages[0].id ?? 'line-req:'+xLineRequestId ?? 'line-sent:'+draftId`。
     - **409 Conflict** = 同一 `X-Line-Retry-Key` が既に受理済 (=配信済) → 送信成功と同義。`status='sent'`,
       `externalMessageId = sentMessages[0].id ?? 'line-accepted:'+xLineAcceptedRequestId ?? 'line-retry-conflict:'+draftId`
       (codex R2 #1 / R3 注: `x-line-accepted-request-id` を使う。`x-line-request-id` は再試行側IDなので配送識別子として弱い)。
     - その後 `upsertOutboundMessage(ticket_id, formatChannelMessageId('line-reply', draftId), body, sentAt)`。
   - **失敗分類** (codex CONCERN R1 #4/#5 + R2 #2):
     - **429 を本文で二分** (codex R2 #2): rate limit (一時) → transient。
       月間上限超過 (`message` に "monthly limit" 等) → **permanent (`failed`)** — 再送しても当月は不可、cron 連打を防ぐ。
     - transient (429-ratelimit / 5xx / network/timeout) → `status='approved'` に戻す + last_error。次 cron で再送。
     - permanent (4xx≠429: 400/401/403/404 / 429-quota) → `status='failed'` + last_error。**再送しない**。
   - 200ms sleep。
7. `OutboundResult` を返す (attempted/succeeded/failed/errors) — 楽天と同一の型。

> 注: これは楽天 outbound.ts (approved 維持で無限再送・claim 無し) に対する**改善**。楽天への後追い適用は本ゴール外
> (LINE で確立後に別 PR で横展開可)。`sending`/`failed` status 追加は ticket_drafts 共有のため楽天送信にも無害 (楽天は使わないだけ)。

### 3.5 スキーマ変更 (ticket_drafts.status 追加, 加法的・低リスク)
現状 CHECK = `{pending, approved, sent, rejected}` (既存データは pending のみ)。
新マイグレーション (`supabase/migrations/<ts>_ticket_drafts_status_sending_failed.sql`):
```sql
alter table public.ticket_drafts drop constraint ticket_drafts_status_check;
alter table public.ticket_drafts add constraint ticket_drafts_status_check
  check (status in ('pending','approved','sent','rejected','sending','failed'));
```
- `sending` = 送信 claim 中 (transient)。`failed` = 非リトライ恒久失敗 (terminal)。
- 加法的変更で既存行・楽天送信に影響なし。Supabase ブランチ検証推奨。

### 3.3 送信 cron `app/api/cron/line-sync/route.ts` (新規, **送信専用**)
- `export const runtime='nodejs'; dynamic='force-dynamic'; maxDuration=300;`
- `authorizeApiRoute(req, { tier: 'cron' })`。
- active `channels(code='line')` を loop → `sendApprovedLineDrafts(ch, makeLogger('line-sync:outbound'))`。
- **受信は呼ばない** (LINE は push webhook 受信のため cron で pull しない)。
- 結果集計し 207/200/500。`POST = GET`。
- `vercel.json` crons に `{ "path": "/api/cron/line-sync", "schedule": "*/5 * * * *" }` 追加。

### 3.4 reply token vs push の判断 (根本原因ベース)
- LINE reply token は **発行後 ~1分・1回限り**。本フローは人手承認 + cron(最大5分) を挟むため、
  送信時点でほぼ確実に失効。→ **push API を唯一の送信経路**とする (origin-core 自前送信も push を使用)。
- reply token フォールバックは本フローでは無効化要因にしかならないため **採用しない** (誤った汎用化を避ける)。
  channel_meta.userId が push の宛先で必要十分。

---

## 4. テスト計画 (段階2 unit + 段階3 モックE2E)

### unit (vitest, contract 経路)
- `line/auth.test.ts`: `buildLineAuthHeader` が `Bearer <token>`、token 欠落で throw。
- `line/client.test.ts`: pushMessage が正しい URL/method/Authorization/`X-Line-Retry-Key`/body を送る (fetch mock)。
  429→backoff→成功、4xx→LineApiError。
- `line/outbound.test.ts`:
  - approved + safe filter のみ load (manual / ai_draft|rag&is_separated)。
  - userId 欠落 draft は skip & last_error。
  - POST 2xx で status=sent + sent_at + external_message_id を **送信前ではなく送信直後**に書く順序。
  - external_message_id 解決優先順位 (sentMessages.id > x-line-request-id > draftId)。
  - 二重実行で2回目は approved が無く送らない (冪等)。
- `cron/line-sync` の認可 (cron tier) ハッピー/401。

### モックE2E (段階3)
- 受信: `verifyLineSignature` を実 channel_secret(テスト値) で通し、`/api/channels/line/inbound` に署名付き POST。
  → ticket+inbound message upsert、embed をモックして `ticket_drafts(pending)` 生成を確認。
- 承認: draft.status を approved に。
- 送信: LINE push を **モック/サンドボックス**で受け、`sendApprovedLineDrafts` が正しい payload で叩き、
  status=sent / messages outbound / 二重送信なし / 認証は Core 解決 (getCredential mock) を確認。
- 実キー必須部分 (実 push 着信) は結線確認のみ。実機は §6 のトムゲート後。

---

## 5. 設定不整合の是正 (配線に必須)

1. **cs-manager `channels(code=line).config` に `scope_key` 追加** = LINE の **Channel ID**。
   現状 config = `{phase, ingestion, service_code}` で `scope_key` 欠落。Core 定義は `scope_key_required=true`。
   → 無いと受信署名検証も送信も `getCredential('line_messaging', null)` で 404→503。
   (`phase` も `2.0_shell_only` → 配線後 `2.1_wired` 等へ更新を推奨。)
2. **Core `external_service_credentials` に `line_messaging` / scope_key=<Channel ID> を投入** (channel_access_token, channel_secret, display_name)。現状 0件。← **トム作業**。

> 注: 1 を cs-manager 側マイグレーション/設定変更で行うか、トムが管理UIで行うかは段階3で確定。
> credential 投入 (2) は人手ゲート。

---

## 6. 本物実機 E2E に必要なトム作業 (人間ゲート)

1. **Core に LINE 認証情報を投入** (DB `fqzsxjhhdzrliuuooqic`, `external_service_credentials`):
   `service_code='line_messaging'`, `scope_key='<LINEのChannel ID>'`,
   secret = `{channel_access_token, channel_secret, display_name}` (LINE Developers Console から取得)。
2. **cs-manager LINE channel の `config.scope_key` に同じ Channel ID を設定** (§5-1)。
3. **LINE Developers Console > Messaging API > Webhook URL を cs-manager に向ける**:
   `https://cs-manager-chi.vercel.app/api/channels/line/inbound` (Use webhook = ON)。
   ※ origin-core の `/api/messages/webhook/line` ではない。両方有効だと LINE は1URLにしか送れないため
     **cs-manager に一本化**。origin-core 側 integration_map の line は本ゴールでは無効化/非使用とする (要トム合意)。
4. (任意) origin-core 側 LINE Hub を今後どうするか (廃止 / 併存) はゴール外。本ゴールは cs-manager 経路で完結。

---

## 7. codex 設計レビュー結果 (2026-06-25)

**判定: R1 CONCERN → R2 CONCERN → R3 で APPROVE 取得 (3 ラウンド)。段階2 着手可。**

- R1 CONCERN: userId欠落・恒久4xx の approved 維持は無限再送 / cron 排他なし → §3.2 claim + 失敗分類 + §3.5 status 追加で解消。
- R2 CONCERN (LINE 仕様精緻化): 409=送信成功扱い / 429 を rate-limit と月間上限に二分 / retry-key 窓24h を踏まえ stale 2段化 → §3.2-3,6 で解消。
- R3 **APPROVE**: 「二重送信・無限再送・LINE retry/429 仕様の主要懸念は解消済み」。実装注 (非ブロッキング): 409 の external_message_id は `sentMessages[0].id` → `x-line-accepted-request-id` の順 (§3.2-6 に反映済)。

| # | 論点 | codex 回答 | 反映 |
|---|---|---|---|
| 1 | origin-core webhook 不使用・cs-manager 直受け一本化 | 妥当 (B案整合) | §3-A 確定 |
| 2 | 送信 push 一択 (reply token 不採用) | 妥当 | §3.4 確定 |
| 3 | 二重送信防止 (POST直後コミット + retry-key) | 方向妥当だが **claim 排他を追加せよ** | §3.2-5 atomic claim 追加 |
| 4 | userId 欠落 draft | **approved 維持は不可。非リトライ failed へ** | §3.2-6 failed 化 |
| 5 | 恒久 4xx | **approved 維持は不可。4xx≠429 は failed、429/5xx/network のみ再送** | §3.2-6 失敗分類 |
| 6 | 送信専用 cron 新設 | 妥当 (責務明確) | §3.3 確定 |

**1回目 CONCERN の要旨**: 「大枠承認可。ただし userId欠落・恒久4xx の approved 維持は無限再送リスク →
非リトライ失敗状態と送信排他を設計に明記すべき」。→ §3.2 (claim + 失敗分類) / §3.5 (status 追加) で解消済み。

### 7.1 実装後 codex code review (codex review --commit, 2026-06-25)
1回目 3 指摘 → 全て修正 → PASS:
- **P1 stale 再回収レース**: SELECT→id 限定 UPDATE だけだと並行 cron が再 claim した fresh 'sending' を
  踏み潰し得る。→ UPDATE に `status='sending'` + `updated_at < 閾値` を再ガード (outbound.ts reclaimStaleSending)。
- **P2a group/room 誤送**: group/room の source にも sender userId が入るため userId だけで push すると
  個人へ private 誤送。→ normalize で `channel_meta.sourceType` を保存し、送信は `resolvePushUserId`
  (sourceType='user' の 1:1 のみ push、それ以外 null→failed) を使う。
- **P2b 配信済の再 queue**: push 成功後の DB 記録失敗で approved に戻すと retry-key 失効後 (>24h) に再配信。
  → 配信成功後の DB 失敗は requeue せず 'sending' のまま残す (15m–24h は再送→409 で収束 / >24h は failed)。
