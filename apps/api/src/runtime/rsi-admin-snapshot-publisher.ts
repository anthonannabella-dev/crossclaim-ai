/**
 * Admin 快照发布器（RSI-RT-10）
 * ---------------------------------------------------------------
 * 周期性把健康态 + 台账聚合成 `rsi-admin-snapshot-v1` 并写盘（供 /admin/autonomy 只读展示）。
 *   · 写入通过注入的 `write` 完成（宿主决定真实落盘位置与权限）；
 *   · 纯产数据：不读凭据、不写库、不外写；
 *   · 无快照内容变化时不产生噪声输出（只在发布成功时回调，不打印状态）。
 */

import {
  RSI_ADMIN_SNAPSHOT_SCHEMA,
  buildAdminSnapshot,
  type RsiAdminHealth,
} from './rsi-admin-snapshot';
import type { RsiCostLedger } from '../services/autonomy/rsi-cost-ledger';
import type { RsiCostUsage } from '../services/autonomy/rsi-cost-policy';

export interface RsiSnapshotPublisher {
  publishOnce(): Promise<{ ok: boolean; bytes: number }>;
  start(): void;
  stop(): void;
  publishes(): number;
}

export function createAdminSnapshotPublisher(options: {
  path: string;
  write: (path: string, content: string) => Promise<void>;
  ledger: RsiCostLedger;
  healthProvider: () => RsiAdminHealth;
  usageProvider: () => RsiCostUsage;
  now?: () => Date;
  intervalMs?: number;
  setIntervalImpl?: (handler: () => void, ms: number) => unknown;
  clearIntervalImpl?: (handle: unknown) => void;
}): RsiSnapshotPublisher {
  const now = options.now ?? (() => new Date());
  const intervalMs = options.intervalMs ?? 60_000;
  let timer: unknown = null;
  let count = 0;

  const publishOnce = async (): Promise<{ ok: boolean; bytes: number }> => {
    try {
      const snapshot = buildAdminSnapshot({
        health: options.healthProvider(),
        ledger: options.ledger,
        usage: options.usageProvider(),
        now: now(),
      });
      if (snapshot.schema !== RSI_ADMIN_SNAPSHOT_SCHEMA) return { ok: false, bytes: 0 };
      const content = JSON.stringify(snapshot, null, 2) + '\n';
      await options.write(options.path, content);
      count += 1;
      return { ok: true, bytes: content.length };
    } catch {
      return { ok: false, bytes: 0 }; // 发布失败不抛给调用方（控制器不应因此崩溃）
    }
  };

  return {
    publishOnce,
    start(): void {
      if (timer !== null) return; // 幂等：不创建第二个 timer
      const setIntervalFn = options.setIntervalImpl ?? ((handler, ms) => setInterval(handler, ms));
      timer = setIntervalFn(() => {
        void publishOnce();
      }, intervalMs);
    },
    stop(): void {
      if (timer === null) return;
      const clearFn = options.clearIntervalImpl ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
      clearFn(timer);
      timer = null;
    },
    publishes: () => count,
  };
}

export const RSI_ADMIN_SNAPSHOT_PUBLISHER_BOUNDARY = {
  writesOnlyOwnArtifact: true,
  writesDatabase: false,
  performsExternalWrite: false,
  readsCredentials: false,
  idempotentStart: true,
} as const;
