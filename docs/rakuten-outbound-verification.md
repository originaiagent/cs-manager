# 楽天 R-MessE 店舗送信メッセージ (店舗側返信) 取り込み検証レポート

## 判定: 可 (PASS)

楽天 R-MessE の `GetInquiry` レスポンスには店舗側回答 (`replies[]`) が含まれており、
cs-manager はこれを双方向に取り込んで表示している。以下、コードパスを根拠として示す。

---

## 1. API 仕様基盤

`src/channels/rakuten/types.ts` の型定義は JakeJP/Rakuten.RMS.Api (.NET 互換ライブラリ) の
モデルに準拠する（ファイル先頭 JSDoc コメント参照）。

```
// src/channels/rakuten/types.ts:13-21
export interface RakutenInquiryReply {
  id: number;
  message: string;
  regDate: string;
  isRead?: boolean;
  isMessageDeleted?: boolean;
  attachments?: RakutenInquiryAttachment[];
}

// types.ts:39
replies?: RakutenInquiryReply[];   // 店舗側回答の配列

// types.ts:53-55
export interface RakutenGetInquiryResponse {
  result: RakutenInquiry;           // replies[] を含む詳細
}
```

公式 InquiryManagementAPI の `GET /inquiry/{inquiryNumber}` は問い合わせ詳細 1 件を返し、
その中に `replies[]` コレクションとして店舗回答履歴が含まれる。

---

## 2. 詳細取得 (getInquiry)

`src/channels/rakuten/client.ts:109-112` で `GET /inquiry/{inquiryNumber}` を実行する:

```typescript
async getInquiry(inquiryNumber: string): Promise<RakutenGetInquiryResponse> {
  const url = `${this.cfg.apiBase.replace(/\/$/, '')}/inquiry/${encodeURIComponent(inquiryNumber)}`;
  return rakutenRequest<RakutenGetInquiryResponse>(url, this.authHeader, { method: 'GET' });
}
```

---

## 3. アダプタでの双方向マッピング

`src/channels/rakuten/adapter.ts` の `fetchInbox` 内 (lines 163-186) は、
各問い合わせについて詳細を取得してから、inbound + outbound の両方を生成する:

```typescript
// adapter.ts:178-183
const ticket = toNormalizedTicket(detail);
const messages: NormalizedMessage[] = [toInboundMessage(detail)];   // 顧客の問い合わせ
for (const reply of detail.replies ?? []) {
  messages.push(toOutboundMessage(reply));                           // 店舗側返信を追加
}
```

`toOutboundMessage` (adapter.ts:84-96) は返信を `direction: 'outbound'`、`senderType: 'staff'`、
`channelMessageId: formatChannelMessageId('reply', reply.id)` = `'reply:<id>'` で正規化する。

---

## 4. DB 永続化 (upsertMessages)

`app/api/cron/rakuten-sync/route.ts:151-171` の `upsertMessages` は inbound/outbound を
区別せず `messages` テーブルへ upsert する:

```typescript
const { error, count } = await supa
  .from('messages')
  .upsert(rows, { onConflict: 'ticket_id,channel_message_id', count: 'exact' });
```

`direction` カラムに `'inbound'` / `'outbound'` がそのまま保存される。

---

## 5. UI 双方向表示

`app/tickets/[id]/page.tsx:44-49` で `messages` テーブルを `sent_at` 昇順で取得し、
`app/tickets/[id]/_components/message-thread.tsx` が方向に応じてバブルを左右に配置する:

```typescript
// message-thread.tsx:27-28
const isOutbound = m.direction === 'outbound';
className={`flex ${isOutbound ? 'justify-end' : 'justify-start'}`}

// message-thread.tsx:45
{isOutbound ? '🟦 自社' : '👤'} {m.sender_name ?? '不明'}
```

outbound バブルは右寄せ・`🟦 自社` ラベルで描画される。

---

## 6. 冪等性 (重複排除)

`messages` テーブルは `(ticket_id, channel_message_id)` UNIQUE 制約を持ち、
`upsertMessages` は `onConflict: 'ticket_id,channel_message_id'` で衝突時に更新する。
返信の `channel_message_id` は `'reply:<reply.id>'` (数値 ID) で一意なため、
同一 cron 複数回実行でも重複行は生まれない。

---

## 7. 既知の課題: reply-pending / reply の二重行リスク

`src/channels/rakuten/outbound.ts:278-284` は、POST /inquiry/reply 直後に
**cs 側で先行して** outbound message を upsert する。この時の `channel_message_id` は
`formatChannelMessageId('reply-pending', draft.id)` = `'reply-pending:<draftId>'` (UUID) である。

```typescript
// outbound.ts:278-284
await upsertOutboundMessage(
  draft.ticket_id,
  formatChannelMessageId('reply-pending', draft.id),   // 'reply-pending:<uuid>'
  draft.body,
  sentAt,
);
```

その後の次回 cron 実行 (fetchInbox → getInquiry → replies[]) では、楽天 API が返す
同一返信を `'reply:<numeric-id>'` でインポートする。

**2 つの channel_message_id は異なるため UNIQUE 制約を回避し、両行が共存する。**
結果として、スレッドに同じ返信内容が 2 件表示される可能性がある:

| channel_message_id | 登録タイミング | 備考 |
|---|---|---|
| `reply-pending:<uuid>` | POST 送信直後 | outbound.ts が即時挿入 |
| `reply:<numeric_id>` | 次回 fetchInbox cron | adapter が replies[] から取り込み |

### 重大度

**Medium** — 機能上のバグではあるが、データ消失はなく、両方の行が送信済み自社メッセージを
表している。ユーザーはスレッドで同じメッセージを 2 回見ることになる。

### 推奨フォローアップ

- `resolveExternalMessageId` (outbound.ts:210-238) で `reply.id` が特定できた場合、
  `reply-pending:<uuid>` 行を削除またはその `channel_message_id` を `reply:<id>` に更新する。
- または fetchInbox 側で、`'reply-pending:*'` 形式の既存行があれば上書き upsert する。
- どちらの修正も **このレポートの範囲外**。コード変更なしで確認のみ。
