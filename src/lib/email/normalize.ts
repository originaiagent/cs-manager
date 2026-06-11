/**
 * メール inbound ペイロードの検証・正規化 (PII を log に出さない方針)
 *
 * cs-manager 独自の正規化契約。将来 IMAP poller / プロバイダ webhook
 * (SendGrid Inbound Parse 等) を載せる場合は、この契約に写像する thin adapter を
 * 足すだけで本体経路を再利用できる。
 */

export interface RawEmailInbound {
  /** envelope/original recipient を優先 (どの inbox 宛か) */
  to?: unknown;
  from?: unknown;
  from_name?: unknown;
  subject?: unknown;
  text?: unknown;
  /** メール Message-ID。デデュープ・external_id の源 */
  message_id?: unknown;
  /** ISO 8601。省略時はサーバ受信時刻 */
  received_at?: unknown;
  /** スレッド化用 (将来利用)。現状は channel_meta に保持するのみ */
  in_reply_to?: unknown;
  references?: unknown;
  thread_id?: unknown;
}

export interface NormalizedEmailInbound {
  to: string;
  /** lower(trim) 済みの照合用アドレス */
  toNormalized: string;
  from: string | null;
  fromName: string | null;
  subject: string | null;
  text: string;
  messageId: string;
  receivedAt: string;
  threadMeta: {
    in_reply_to: string | null;
    references: string | null;
    thread_id: string | null;
  };
}

export interface EmailNormalizeError {
  field: string;
  message: string;
}

/** 受信本文の最大長 (DoS / 過大ペイロード対策)。これを超えたら拒否。 */
export const MAX_EMAIL_TEXT_LENGTH = 100_000;

function asTrimmedString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/** メールアドレスを照合用に正規化 ("Name <a@b>" 形式から addr-spec を抽出)。 */
export function normalizeAddress(raw: string): string {
  const angle = raw.match(/<([^>]+)>/);
  const addr = angle ? angle[1] : raw;
  return addr.trim().toLowerCase();
}

/**
 * 生ペイロードを検証・正規化する。失敗時は errors を返す (PII を含めない)。
 */
export function normalizeEmailInbound(
  raw: RawEmailInbound,
  nowIso: string,
): { ok: true; value: NormalizedEmailInbound } | { ok: false; errors: EmailNormalizeError[] } {
  const errors: EmailNormalizeError[] = [];

  const to = asTrimmedString(raw.to);
  if (!to) errors.push({ field: 'to', message: 'required' });

  const text = typeof raw.text === 'string' ? raw.text : null;
  if (text === null || text.trim().length === 0) {
    errors.push({ field: 'text', message: 'required' });
  } else if (text.length > MAX_EMAIL_TEXT_LENGTH) {
    errors.push({ field: 'text', message: `exceeds ${MAX_EMAIL_TEXT_LENGTH} chars` });
  }

  const messageId = asTrimmedString(raw.message_id);
  if (!messageId) errors.push({ field: 'message_id', message: 'required' });

  let receivedAt = nowIso;
  const rawReceived = asTrimmedString(raw.received_at);
  if (rawReceived) {
    const d = new Date(rawReceived);
    if (Number.isNaN(d.getTime())) {
      errors.push({ field: 'received_at', message: 'invalid date' });
    } else {
      receivedAt = d.toISOString();
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      to: to as string,
      toNormalized: normalizeAddress(to as string),
      from: asTrimmedString(raw.from),
      fromName: asTrimmedString(raw.from_name),
      subject: asTrimmedString(raw.subject),
      text: text as string,
      messageId: messageId as string,
      receivedAt,
      threadMeta: {
        in_reply_to: asTrimmedString(raw.in_reply_to),
        references: asTrimmedString(raw.references),
        thread_id: asTrimmedString(raw.thread_id),
      },
    },
  };
}
