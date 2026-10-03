/**
 * 尝试账本端口 + 内存实现
 * ---------------------------------------------------------------
 * 落库账本属于 Schema 变更，需架构方单独裁决；本批次只提供端口与内存实现，
 * 供服务编排与测试使用（不得在生产路径上用内存实现冒充持久化）。
 */

import type { PlatformWriteLedger, PlatformWriteLedgerEntry } from './types';

export interface InMemoryPlatformWriteLedger extends PlatformWriteLedger {
  readonly entries: Map<string, PlatformWriteLedgerEntry>;
  size(): number;
}

export function createInMemoryPlatformWriteLedger(): InMemoryPlatformWriteLedger {
  const entries = new Map<string, PlatformWriteLedgerEntry>();
  return {
    entries,
    async read(key: string) {
      const found = entries.get(key);
      return found ? { ...found } : null;
    },
    async write(entry: PlatformWriteLedgerEntry) {
      entries.set(entry.key, { ...entry });
    },
    size() {
      return entries.size;
    },
  };
}
