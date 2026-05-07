import type { ChannelAdapter } from './adapter';
import { rakutenAdapter } from '../rakuten/adapter';

/**
 * 利用可能な adapter を code で引くレジストリ。
 * Phase 2 で他チャネルを追加する際はここに登録する。
 */
const REGISTRY: Record<string, ChannelAdapter> = {
  [rakutenAdapter.code]: rakutenAdapter,
};

export function getChannelAdapter(code: string): ChannelAdapter | null {
  return REGISTRY[code] ?? null;
}

export function listAdapterCodes(): string[] {
  return Object.keys(REGISTRY);
}
