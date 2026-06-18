/**
 * cs-manager AI 能力マニフェスト (business-concept 粒度・手書き)。
 *
 * backlog 20a408eb「全ツール AI 能力カタログ」Stage2 ファンアウト。参照実装: ec-manager。
 * docs/tool-capability-catalog-design.md (origin-ai) の §3.1 JSON 形に準拠。
 *
 * 目的: このツールが「自分の AI 能力」を concept / 別名 / endpoint / 入出力 schema /
 * 人間可読 description として公開し、origin-core が集約してメタエージェントが
 * ユーザーの自然言語 (例「対応履歴」) を正しいツール概念へ意味照合できるようにする。
 *
 * 不変条件 (厳守):
 *   - 全て read 専用・副作用なし・純データ提供のみ (提案生成や書込は origin-ai 側だけ)。
 *   - endpoint は内部鍵 (X-Internal-API-Key) 必須。
 *   - 既存挙動は一切変えない (additive / dark)。
 *
 * 編集ガイド:
 *   - description は cs-manager の実画面 (受信箱 / 対応記録 / ナレッジ / 品質) の説明文を
 *     取り込む。推測・創作は禁止し、実在機能のみ記述する。
 *   - slug は ASCII kebab で安定 ID。endpoint.path の末尾と 1:1 対応させる。
 *   - capability を増やす場合は CAPABILITIES に追記し、対応する
 *     app/api/ai/capabilities/[slug]/route.ts の dispatch に実データ read を足す。
 */

export interface CapabilityEndpoint {
  method: 'GET';
  path: string;
}

export interface Capability {
  /** 正準名 (日本語可・人間語)。 */
  concept: string;
  /** 安定 ID (ASCII kebab・endpoint と対応)。 */
  slug: string;
  /** 別名 (ユーザー語 → concept の意味照合素材)。 */
  aliases: string[];
  /** 画面説明文を取り込んだ人間可読 description (実在機能のみ)。 */
  description: string;
  /** 業務ドメイン。 */
  domain: string;
  /** read 専用フラグ (本件は常に true)。 */
  read_only: true;
  /** 内部鍵必須・read 専用・純データの取得 endpoint。 */
  endpoint: CapabilityEndpoint;
  /** 入力 JSON Schema。 */
  input_schema: Record<string, unknown>;
  /** 出力 JSON Schema。 */
  output_schema: Record<string, unknown>;
}

export interface CapabilityManifest {
  /** origin-core tools.name と一致。 */
  tool_slug: string;
  schema_version: string;
  /** ISO8601。集約側はこれを取得日時の参考にする (権威は fetched_at)。 */
  generated_at: string;
  generator: 'manual';
  capabilities: Capability[];
}

export const TOOL_SLUG = 'cs-manager';
export const SCHEMA_VERSION = '1.0.0';
// 手書きマニフェストのため固定値 (生成日時)。挙動には影響しない (純メタデータ)。
export const GENERATED_AT = '2026-06-18T00:00:00.000Z';

/**
 * capability: 顧客対応 (customer-service)
 *
 * データ源: customer_service_records (顧客対応記録)。
 * 画面: 「対応記録」(返信のみ / 不良再送 / 不良返金 / お客様都合再送 / お客様都合返金 /
 *        おまけ発送 / 関係構築発送 の対応を 1 レコード = 1 対応として保存)。
 *        「受信箱」(amazon / rakuten / yahoo 等のチャネルから取り込んだ問い合わせ一覧)。
 */
const CUSTOMER_SERVICE: Capability = {
  concept: '顧客対応',
  slug: 'customer-service',
  aliases: [
    'カスタマーサポート',
    '問い合わせ',
    'CS',
    '顧客記録',
    '対応履歴',
    '対応記録',
    '顧客対応記録',
    '受信箱',
    '返信',
    '返品',
    '返金',
    '再送',
    '追加発送',
  ],
  description:
    'amazon・楽天・Yahoo 等の複数チャネルから取り込んだ顧客問い合わせと、その対応履歴を管理する。' +
    '対応記録は「返信のみ / 不良品の再送・返金 / お客様都合の再送・返金 / おまけ発送 / 関係構築発送」を' +
    '1 レコード = 1 対応として保存し、商品・受取人・注文番号・対応種別・対応日で検索できる。',
  domain: 'カスタマーサポート',
  read_only: true,
  endpoint: {
    method: 'GET',
    path: '/api/ai/capabilities/customer-service',
  },
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      limit: { type: 'number', minimum: 1, maximum: 1000, description: '最大取得件数 (1-1000)' },
      product: { type: 'string', description: '商品名の部分一致 (product_name_text)' },
      recipient: { type: 'string', description: '受取人名の部分一致 (recipient_name)' },
      order: { type: 'string', description: '注文番号の部分一致 (order_number)' },
      action_type: {
        type: 'string',
        description: '対応種別の完全一致',
        enum: [
          'reply_only',
          'reship_defect',
          'refund_defect',
          'reship_customer',
          'refund_customer',
          'addon_send',
          'relation_send',
        ],
      },
      date_from: { type: 'string', description: '対応日 (record_date) の下限 YYYY-MM-DD' },
      date_to: { type: 'string', description: '対応日 (record_date) の上限 YYYY-MM-DD' },
    },
    required: [],
  },
  output_schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      records: {
        type: 'array',
        description: '顧客対応記録 (customer_service_records) の行',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            product_id: { type: ['integer', 'null'] },
            product_name_text: { type: 'string' },
            variation_text: { type: ['string', 'null'] },
            recipient_name: { type: 'string' },
            recipient_honorific: { type: 'string' },
            order_number: { type: ['string', 'null'] },
            order_channel: { type: ['string', 'null'] },
            action_type: { type: 'string' },
            amazon_gift_amount: { type: ['number', 'null'] },
            reship_tracking: { type: ['string', 'null'] },
            record_date: { type: 'string' },
            line_account: { type: ['string', 'null'] },
            memo: { type: ['string', 'null'] },
            defect_type: { type: ['string', 'null'] },
            ticket_id: { type: ['string', 'null'] },
            created_at: { type: 'string' },
            updated_at: { type: 'string' },
          },
        },
      },
      count: { type: 'number', description: '条件に一致した総件数' },
    },
    required: ['ok', 'records', 'count'],
  },
};

export const CAPABILITIES: Capability[] = [CUSTOMER_SERVICE];

export const manifest: CapabilityManifest = {
  tool_slug: TOOL_SLUG,
  schema_version: SCHEMA_VERSION,
  generated_at: GENERATED_AT,
  generator: 'manual',
  capabilities: CAPABILITIES,
};

/** slug から capability を引く (endpoint の dispatch 用)。 */
export function getCapability(slug: string): Capability | undefined {
  return CAPABILITIES.find((c) => c.slug === slug);
}
