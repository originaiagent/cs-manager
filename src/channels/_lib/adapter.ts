import type { NormalizedTicketWithMessages } from './types';

/**
 * adapter から見える channels テーブル 1 行分の情報
 */
export interface AdapterChannelRow {
  id: string;
  code: string;
  config: Record<string, unknown>;
}

export interface AdapterLogger {
  info: (msg: string, extra?: Record<string, unknown>) => void;
  warn: (msg: string, extra?: Record<string, unknown>) => void;
  error: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface ChannelAdapterContext {
  channel: AdapterChannelRow;
  /** 増分起点。null なら adapter が config の lookback_minutes に基づき初回起点を決める */
  since: Date | null;
  logger: AdapterLogger;
  /**
   * 受信ワーカー (orchestrator) が `channels.config.service_code` + scope_key から
   * Core /api/credentials 経由で解決した認証情報。
   *
   * - pull チャネルでは orchestrator が必ず populate する (キー未投入チャネルは
   *   そもそも graceful skip され adapter まで到達しない)。
   * - adapter は service_code を知らず、ここに渡された credentials を使う
   *   (service_code ハードコード禁止の徹底)。
   * - 自前で credential 解決する旧来 adapter (rakuten 専用 cron 経路) では undefined。
   */
  credentials?: Record<string, unknown>;
}

/**
 * 全チャネル adapter が満たすべき最小契約。
 *
 * 規約:
 *  - code は channels.code と一致する
 *  - fetchInbox は ticket+messages を 1 件ずつ yield（メモリ効率と部分失敗許容のため）
 *  - 認証情報は adapter 自身が取得（楽天は env、将来は channel_credentials）
 *  - ページネーション・レート制限ディレイは adapter 内部で処理
 *  - 致命的エラーは throw（orchestrator が channel 単位で try/catch）
 */
export interface ChannelAdapter {
  readonly code: string;
  fetchInbox(
    ctx: ChannelAdapterContext,
  ): AsyncGenerator<NormalizedTicketWithMessages, void, void>;
}
