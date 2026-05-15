/**
 * channelMessageId の採番ヘルパー
 *
 * (ticket_id, channel_message_id) UNIQUE で重複排除しているため、
 * adapter ごとに prefix 規約をバラさず、ここを通すことで一貫性を保つ。
 *
 * 例:
 *   formatChannelMessageId('inquiry', '123456')   → 'inquiry:123456'
 *   formatChannelMessageId('reply',   789012)      → 'reply:789012'
 */
export function formatChannelMessageId(prefix: string, id: string | number): string {
  if (!prefix) throw new Error('formatChannelMessageId: prefix is required');
  if (id === null || id === undefined || id === '') {
    throw new Error('formatChannelMessageId: id is required');
  }
  return `${prefix}:${id}`;
}
