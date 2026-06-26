# 統合設計: Yahoo受信 + 楽天店舗送信(双方向) + 件名ロジック共通化

段階1インターフェース定義 (codex セカンドオピニオン対象 / 着手前)。
対象: cs-manager。DB=jpnsoqzzylahpandbfcz / Core=fqzsxjhhdzrliuuooqic / origin-ai=origin-ai-five。

---

## 0. 現状分析 (重要: 大半が実装済み。本設計は「共通化」と「欠落穴埋め」)

コード調査で確定した既存実装:

| 項目 | 既存状態 | 出典 |
|---|---|---|
| Yahoo pull adapter | **実装済**: `fetchInbox` / Core credential `yahoo_shopping` / orchestrator allowlist / registry 登録 / postUserType→direction (inbound+outbound 両方を捕捉) | `src/channels/yahoo/{adapter,client,types}.ts`, `orchestrator.ts:18` |
| Yahoo channels 行 | **作成済**: `code=yahoo status=active config={ingestion:pull, service_code:yahoo_shopping, scope_key_field:store_id}` (store_id 未投入) | DB channels |
| 楽天 outbound(店舗送信)取込 | **実装済**: adapter が `detail.replies[]` → `toOutboundMessage(direction=outbound)`、rakuten-sync が `upsertMessages` で冪等永続化 | `rakuten/adapter.ts:181`, `cron/rakuten-sync/route.ts:207` |
| スレッド双方向表示 | **実装済**: `messages` を sent_at 昇順取得、`MessageThread` が inbound(左/👤) outbound(右/🟦自社) を描画 | `tickets/[id]/page.tsx:44`, `message-thread.tsx:27` |
| 共通 ingest (push) | **実装済**: `ingestInboundWithDraft` (冪等 upsert → origin-ai embed draft → ticket_drafts) | `lib/sync/ingest-inbound.ts` |
| origin-ai 集約 | **実装済**: 業務 AI は cs 内に持たず embed oneshot (`cs-reply:draft`) へ委譲 | `lib/embed/run-oneshot.ts`, `lib/rag/reply-adapter.ts` |

### 現状の「件名」生成 (= 今回の主対象。バラバラ + 商品名混入)

| チャネル | 現在の subject | 問題 |
|---|---|---|
| 楽天 | `inq.itemName ? '[${itemName}] ${message.slice(0,60)}' : undefined` (`rakuten/adapter.ts:61`) | **商品名混入** + 本文断片。用件不明 |
| Yahoo | `topic.title ?? headline.title` (`yahoo/adapter.ts:156`) | Yahoo 提供タイトル。用件要約でない |
| メール | `email.subject` (メール件名そのまま) (`email/ingest-email.ts:113`) | 商品名が入りうる。用件統一でない |
| LINE | なし (`null`) (`line/normalize.ts:101`) | 件名なし |

### 現状の欠落 (今回埋める穴)

1. **共通 `generateSubject()` が存在しない** — 各 adapter がインラインで subject を生成。
2. **pull 経路はドラフトを生成しない** — orchestrator (`sync-channels`) は `upsertTicket/upsertMessages` のみ。
   Yahoo 受信は ticket_drafts を作らない (goal の「Yahoo受信→下書き」が未充足)。
   ※ push 経路 (email/line) のみ `ingestInboundWithDraft` で auto-draft。楽天は専用 first-response flow。

---

## 1. 共通件名生成 `generateSubject()` (C 中核 / origin-ai 経由 / prompt ハードコード禁止)

### 1.1 配置と契約

新規 `src/lib/subject/generate-subject.ts`:

```ts
export type SubjectKind = 'inquiry' | 'review';

export interface GenerateSubjectInput {
  /** 1行要約する素材 = 最新 inbound 本文 (raw)。マスクは origin-ai 側。 */
  body: string;
  /** 件名生成対象 ticket UUID (embed target_id)。実在保証済を渡す。 */
  ticketId: string;
  /** 種別ヒント。'review'→「レビュー返信」と分かる件名。既定 'inquiry'。 */
  kind?: SubjectKind;
  /** origin-ai 失敗時のフォールバック。既定 null (= 件名なし、goal 準拠)。 */
  fallback?: string | null;
  /** テスト注入用。未指定なら runEmbedOneshotAndPoll (origin-ai embed)。 */
  runEmbed?: (args: RunEmbedOneshotArgs) => Promise<EmbedOneshotResult>;
}

/**
 * origin-ai embed (oneshot `cs-reply:subject`) 経由で用件ベースの短い件名を生成。
 * - 商品名は含めない (origin-ai 側 prompt が保証。cs に prompt を持たない)。
 * - review は「レビュー返信」等と分かる件名。
 * - 失敗 (鍵未配布 / upstream エラー / 空 / 不正 shape) は fallback (既定 null)。
 * - 例外を投げない (defense-in-depth)。raw body をログ/エラーに出さない。
 * @returns 生成件名 (trim + 120 文字上限) または fallback
 */
export async function generateSubject(input: GenerateSubjectInput): Promise<string | null>;
```

### 1.2 origin-ai 連携 (AI集約 / B案準拠)

- 機構: **既存 embed oneshot** を再利用。`runEmbedOneshotAndPoll({ slug:'cs-reply:subject',
  targetType:'customer_record', targetId:ticketId, input:{ inquiry_text: body, subject_kind: kind } })`。
- origin-ai 側 oneshot `cs-reply:subject` の `output_schema` は `{ subject: string }` を必須化想定。
  `result.subject` を string 検証 → trim → 120 文字 cap して返す。型不一致は fallback。
- prompt (1行要約 / 商品名除外 / review 判定) は **origin-ai 側 skill に存在**。cs に直書きしない。
- 認証/接続 env は既存 `run-oneshot.ts` と同一: **`EMBED_CLIENT_KEY` + `ORIGIN_AI_BASE_URL`**
  (cs-reply embed client を流用、新規鍵を増やさない)。両 env 未設定時は `embed_key_unprovisioned`。
- **origin-ai ゲート**: oneshot slug `cs-reply:subject` を **既存 cs-reply embed client の allowed slug
  に追加** + output_schema `{subject:string}` 定義が origin-ai 側で必要 (別 repo / §8 人間ゲート)。
- **fail-closed**: `cs-reply:subject` が origin-ai 未実装の間は `embed_run_start_4xx` 等で ok:false →
  generateSubject は fallback(null) を返し、cs は「件名なし」で素通り (受信は止めない)。

> **判断ログ**: subject を `cs-reply:draft` の出力に相乗りさせず **独立 oneshot** にする。理由: 件名は
> RAG draft が no_answer/失敗でも必要・軽量要約で十分・draft 不要チャネル(楽天 pull)でも使うため。
> 根拠: 既存踏襲(embed 一本化方針) + 実態優先。

### 1.3 単一経路ヘルパ (ingest 層が呼ぶ唯一の口)

```ts
/**
 * ticket.subject を generateSubject で解決し DB 更新する。
 * - 冪等 (codex CONCERN#1): UPDATE は ... WHERE id=$1 AND (subject IS NULL OR btrim(subject)='')。
 *   既に件名がある行は触らない (再 sync で再要約しない・人手編集を踏み潰さない)。
 * - 生成が non-null のときだけ UPDATE 実行。null(失敗) 時は何もしない = 件名なし維持。
 * - 例外を投げない (subject 失敗で受信/ドラフトを壊さない)。
 */
export async function resolveAndPersistSubject(
  sb: SupabaseClient,
  ticketId: string,
  input: { body: string; kind?: SubjectKind; fallback?: string | null },
): Promise<void>;
```

> **codex CONCERN#1 反映 (subject clobber 防止 / 最重要)**: subject を「ingest 層のみが書く」と
> するには、adapter から subject を消すだけでは不十分。現行 upsertTicket の **既存行 update が
> `subject: payload.subject ?? null` を常に書く**ため、生成済み件名が毎 sync で null に戻る。
> 対策: 3 つの upsertTicket (`ingest.ts:38` / `orchestrator.ts:119` / `rakuten-sync/route.ts:105`) の
> **既存行 update から subject を完全に omit** する。新規 insert 時も subject は書かない (常に
> NULL で作り、`resolveAndPersistSubject` が後追いで条件付き UPDATE する)。これにより subject の
> 書き込み口は `resolveAndPersistSubject` 1 箇所に物理的に収束する。

---

## 2. 単一経路の規約 (干渉点①: 件名)

> **不変条件 (single source of subject)**: inbound ticket の `subject` は **ingest 層で
> `generateSubject()` を通したときのみ** 書き込まれる。adapter / normalize は subject を生成しない。

具体:
- **adapter/normalize は `NormalizedTicket.subject` を設定しない (undefined)**。商品名は
  `product_id` / `channelMeta` へ (件名に絶対入れない)。review スレッドは
  `channelMeta.subjectKind='review'` を立てるだけ。
- **件名生成の発火点 = 新規に insert された inbound message (atomic isNew)** (codex CONCERN#2)。
  「新規 ticket」では不足: 既存 Yahoo/楽天スレッドに follow-up inbound が来た場合 ticket は既存だが
  件名が NULL のままなら生成すべき。逆に outbound-only 更新・再送 (isNew=false) では発火しない。
  → gate は **atomic な inbound message insert 結果 (`upsertMessageReturningNew` の isNew)** とする。
- 呼び出し箇所 (3 箇所、全て ingest 層。発火 gate は全て「新規 inbound message」):
  1. push: `ingestInboundWithDraft` 内 (email/line)。既存の `upsertMessageReturningNew` isNew を流用。
  2. pull(Yahoo): `orchestrator`。**pull 経路の message upsert を per-message returning-new 化** し
     (codex CONCERN#2)、新規 inbound が 1 件以上あれば最新の新規 inbound 本文で発火。
  3. pull(楽天): `rakuten-sync`。同上 (per-message returning-new で新規 inbound を識別)。

`ingestInboundWithDraft` の入力に追加 (後方互換: optional):
```ts
interface IngestInboundParams {
  // ...既存...
  subjectKind?: SubjectKind;        // 既定 'inquiry'
  subjectFallback?: string | null;  // email は native subject を渡してよい (既定 null)
}
```

> **判断ログ (email)**: goal の「origin-ai失敗時フォールバック=件名なし」に従い既定 fallback=null。
> ただし email は native 件名が既に用件であることが多いため、呼出側が `subjectFallback=email.subject`
> を渡せる口を残す (policy は caller 制御)。既定は null で goal 準拠。**要トム判断点**として完了報告に明記。

---

## 3. 双方向取込口 (干渉点②: 共通 ingest / direction)

### 3.1 outbound(店舗→顧客) 取込口 — 既存契約で充足

- outbound message は adapter が `fetchInbox` の `messages[]` に `direction:'outbound'` で yield し、
  `upsertMessages` が `(ticket_id, channel_message_id)` UNIQUE で冪等永続化する (既存)。
- 楽天: `replies[]`→outbound (実装済)。Yahoo: `postUserType`→outbound (実装済)。
- **規約**: outbound は subject 生成・draft 生成を **発火させない** (inbound isNew のみ)。
- UI 双方向表示は実装済 (`MessageThread`)。本タスクで UI 改修不要。

### 3.2 Yahoo pull の auto-draft 口 (新規 / pull 経路の欠落穴埋め)

新規 `src/lib/sync/pull-auto-draft.ts`:
```ts
/**
 * pull 経路 (orchestrator) で **新規に insert された inbound message** に対し RAG ドラフトを
 * 生成し ticket_drafts へ保存する。ingestInboundWithDraft の draft 生成部
 * (fail-closed / parseOk / is_separated=true) を踏襲した pull 用の薄い口。subject 生成とは独立。
 * 失敗しても受信(ticket/message)は壊さない。既定 source='rag'。
 */
export async function generateDraftForNewInbound(
  sb: SupabaseClient,
  args: { channelId: string; ticketId: string; inboundBody: string;
          customerName?: string | null; productId?: string | null },
): Promise<{ status: IngestInboundStatus; draftId?: string; draftError?: DraftErrorCode }>;
```

> **codex CONCERN#3 反映 (draft 冪等)**: `ticket_drafts` は複数下書き前提で DB unique は
> `first_response` のみ (`20260523000000_first_response_flow.sql`)。よって「既存 draft 有無で skip」は
> **誤り** (follow-up inbound の draft を抑止する/並行時に二重生成し得る)。本口は draft 既存チェックを
> **持たず**、発火 gate は **呼出側の atomic な inbound message insert (isNew)** に一本化する
> (push 経路 `ingestInboundWithDraft` と同一規律)。1 新規 inbound = 最大 1 draft。
> 有効化は `channels.config.auto_draft!==false` でデータ駆動 (既定 ON、楽天は本口を使わず除外)。
- 楽天は従来通り first-response flow 経路 (本口は使わない。回帰回避)。Yahoo のみ本口で auto-draft。

---

## 4. Yahoo 認証情報 (Core credential 枠 / 人間ゲート)

- `credential_service_definitions` に `yahoo_shopping` 行は **未登録** (確認済)。これは Core 側データ投入 =
  **人間/Coreゲート**。cs から直接書かない (Bマスタ原則: Core が SSOT)。
- 枠設計 (rakuten/line と同形):
  ```
  service_code: yahoo_shopping
  scope_key_required: true / scope_key_label: 'ストアアカウント(sellerId)'
  fields:
    - access_token (password, secret, required)  # 問い合わせAPI Bearer
    - seller_id    (text, 任意)                   # 未指定時 scope_key=store_id を使用
  ```
- **graceful skip vs misconfig の区別 (codex CONCERN#5)**:
  - credential **不在 (Core 404)** → graceful skip (キー投入で次 tick から自動稼働)。
  - credential **存在するが seller_id も channels.config.store_id も無い** → adapter が throw =
    **misconfig (loud error)**。graceful skip ではない。運用ミスとして検知させる (黙って skip しない)。
- **公式仕様ゲート**: Yahoo!ショッピングAPI は OAuth2 で access_token が短命 (要 refresh)。
  静的 access_token は失効する。go-live 前に「refresh_token + client 資格を枠に持ち定期更新」か
  「運用で access_token を定期投入」を確定する (adapter に refresh 未実装)。
  → モックE2E まではキー無で graceful skip。完了報告の人間ゲートに明記。

---

## 5. 規約まとめ (subagent 共有 contract)

1. **subject 単一経路**: inbound subject は ingest 層 `generateSubject()` のみが書く。adapter/normalize は
   subject 不設定。商品名は subject に入れない (`product_id`/`channelMeta` へ)。
2. **direction**: `messages.direction ∈ {inbound,outbound}`。inbound=顧客 / outbound=店舗・staff。
   subject/draft 発火は **inbound 新規 (isNew) のみ**。
3. **冪等**: `(ticket_id, channel_message_id)` UNIQUE。subject は subject NULL 時のみ生成。
   再 sync・outbound・再送で再生成しない。external_message_id は outbound 送信特定用 (既存)。
4. **AI集約**: 件名要約・返信生成は **origin-ai embed 経由のみ**。cs に prompt/LLM 直叩きを持たない。
   鍵は env (EMBED_CLIENT_KEY) / Core credential。ハードコード禁止。

---

## 6. 段階2 subagent ファイル所有権 (衝突回避 / orchestrator 統合は main が段階3で実施)

| Agent | 新規/編集ファイル (排他所有) | 備考 |
|---|---|---|
| **C 件名** | `src/lib/subject/generate-subject.ts` (新: generateSubject + resolveAndPersistSubject) / `lib/sync/ingest.ts` の upsertTicket **subject omit (push)** / `ingest-inbound.ts` (subject param + isNew 時 resolveAndPersistSubject) / `rakuten/adapter.ts`・`email/ingest-email.ts`・`line/normalize.ts` の **subject 除去** / unit | yahoo adapter・orchestrator・rakuten-sync は触らない |
| **A Yahoo** | `src/lib/sync/pull-auto-draft.ts` (新: generateDraftForNewInbound) / `yahoo/adapter.ts` の **subject 除去** + (任意) `yahoo/normalize.ts` 抽出 / yahoo credential 枠ドキュメント / unit + モックE2E | orchestrator・rakuten-sync は触らない |
| **B 楽天out** | `rakuten/*` の outbound テスト追加・検証レポート (可否+根拠) / 既存 inbound を壊さない確認 | コード変更最小 (検証主体) |
| **main 統合** | `orchestrator.ts`・`rakuten-sync/route.ts`: ① upsertTicket 既存行 update から subject omit ② pull message upsert を **per-message returning-new 化** (新規 inbound 識別) ③ 新規 inbound 時に `resolveAndPersistSubject` + (Yahoo は) `generateDraftForNewInbound` を結線 / E2E | 段階3。pull 共有ファイルは main のみ編集 → subagent と衝突ゼロ |

> orchestrator.ts / rakuten-sync は subject(C)・draft(A)・per-message returning-new 化が交差する
> 干渉点のため、**subagent には触らせず main が段階3で一括結線**する。subagent は自己完結モジュール +
> 所有チャネルファイル + テストのみを出す。C の `ingest.ts`(push upsertTicket) は push 専用で pull と
> 非干渉のため C 所有。

---

## 7. 段階3 E2E 受け入れ基準 (4点確認 = 取得→DB行→GET→UI)

1. Yahoo 受信(モック) → 用件ベース件名(generateSubject 注入モック) → ticket_drafts(pending) 生成。
2. 楽天 RMS 送信(replies[] モック) → outbound message 永続 → スレッド双方向表示。
3. 受信箱一覧の件名が商品名でなく用件ベース (楽天/メール/LINE/Yahoo)。
4. **本タスクが追加するコードに**ハードコード鍵/prompt 0 / subject 要約は origin-ai 経由を grep で実証
   (codex CONCERN#6: repo-wide ではない。既存 `first-response/classify.ts` の分類 prompt は本タスク
   スコープ外・既存コード保全のため非変更。subject 機能は新規 prompt/key を一切足さない)。

---

## 8. 人間/外部ゲート (モックE2Eまではキー無で通す)

- **Yahoo 実データ**: Core `credential_service_definitions.yahoo_shopping` 枠投入 + 実 access_token(OAuth, 失効注意) +
  channels.config.store_id(=sellerId) 投入。投入先 = Core (cs から書かない)。
- **origin-ai subject 能力**: oneshot `cs-reply:subject` (output `{subject}`) を origin-ai 側に追加 (別repo)。
  未実装の間は generateSubject が null フォールバック (件名なし) で安全に素通り。
</content>
</invoke>
