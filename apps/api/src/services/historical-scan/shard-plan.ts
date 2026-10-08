// HISTORICAL_RECOVERY_SCAN_V1 / PHASE 6（纯函数部分）—— 分片计划
// ---------------------------------------------------------------------------
// 约束：**绝不**一次把 5 年数据全部加载到内存；扫描必须按月/季分片，且分片计划必须确定、可重放。
// 该模块只做「分片枚举」（纯函数）；执行与检查点见 backfill-executor / scan-store。

import { SHARD_GRAINS, toScanDay, type ShardGrain } from './scan-identity';

export interface ScanShard {
  readonly index: number;
  /** 稳定 shard key（例如 2021-10 / 2021-Q4）——用于 durable checkpoint 与幂等重放 */
  readonly key: string;
  readonly from: string;
  readonly to: string;
}

const MAX_SHARDS = 240; // bounded

function addMonths(day: string, months: number): string {
  const [year, month, date] = day.split('-').map((part) => Number(part));
  // 必须保留 day-of-month（否则区间起点会被拉到每月 1 号，导致多出尾分片）
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(date, lastDay));
  return target.toISOString().slice(0, 10);
}

function shardKeyOf(day: string, grain: ShardGrain): string {
  const [year, month] = day.split('-').map((part) => Number(part));
  if (grain === 'QUARTERLY') return String(year) + '-Q' + String(Math.floor((month - 1) / 3) + 1);
  return String(year) + '-' + String(month).padStart(2, '0');
}

/** 确定性分片：从 from（含）到 to（含），按月或按季切分。 */
export function planScanShards(input: {
  readonly from: Date | string;
  readonly to: Date | string;
  readonly grain?: ShardGrain;
}): ScanShard[] {
  const grain: ShardGrain = input.grain ?? 'MONTHLY';
  if (!SHARD_GRAINS.includes(grain)) throw new Error('RECOVERY_SCAN_INVALID_GRAIN: ' + String(grain));
  const start = toScanDay(input.from);
  const end = toScanDay(input.to);
  if (start > end) throw new Error('RECOVERY_SCAN_RANGE_INVERTED');

  const stepMonths = grain === 'QUARTERLY' ? 3 : 1;
  const shards: ScanShard[] = [];
  if (start === end) {
    return [{ index: 0, key: shardKeyOf(start, grain), from: start, to: end }];
  }
  let cursor = start;
  let index = 0;
  // 区间语义为 [from, to]；最后一个 shard 截止到 to（不生成零长度尾分片）
  while (cursor < end) {
    if (index >= MAX_SHARDS) throw new Error('RECOVERY_SCAN_TOO_MANY_SHARDS');
    const next = addMonths(cursor, stepMonths);
    const shardTo = next > end ? end : next;
    shards.push({ index, key: shardKeyOf(cursor, grain), from: cursor, to: shardTo });
    cursor = next;
    index += 1;
  }
  return shards;
}
