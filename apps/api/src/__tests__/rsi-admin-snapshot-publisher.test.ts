/** 快照发布器验收：写出合法 schema、幂等起停、失败不抛、只写自己的 artifact。 */

import { describe, expect, it } from 'vitest';

import {
  RSI_ADMIN_SNAPSHOT_PUBLISHER_BOUNDARY,
  createAdminSnapshotPublisher,
} from '../runtime/rsi-admin-snapshot-publisher';
import { createRsiCostLedger } from '../services/autonomy/rsi-cost-ledger';
import type { RsiCostUsage } from '../services/autonomy/rsi-cost-policy';

const usage = (): RsiCostUsage => ({
  spentToday: 0,
  spentThisMonth: 0,
  incidentSpent: 0,
  incidentAttempts: 0,
  incidentCandidates: 0,
  incidentLlmCalls: 0,
  incidentTokens: 0,
  incidentElapsedMinutes: 0,
  strongCallsForTask: 0,
});

const health = {
  health: 'HEALTHY' as const,
  openIncidents: 0,
  activeTasks: 1,
  failedTasks: 0,
  pendingOwnerApprovals: 0,
  lastScanAt: '2026-10-05T02:00:00.000Z',
};

describe('RSI Admin 快照发布器', () => {
  it('RSI_PUBLISHER_WRITES_VALID_SNAPSHOT：写出 rsi-admin-snapshot-v1 且内容可解析', async () => {
    const writes: { path: string; content: string }[] = [];
    const ledger = createRsiCostLedger();
    ledger.recordRuleResolved({ entryId: 'r1', at: new Date().toISOString(), incidentId: 'inc-1' });

    const publisher = createAdminSnapshotPublisher({
      path: '/snapshot.json',
      write: async (path, content) => {
        writes.push({ path, content });
      },
      ledger,
      healthProvider: () => health,
      usageProvider: usage,
      now: () => new Date('2026-10-05T03:00:00.000Z'),
    });

    const result = await publisher.publishOnce();
    expect(result.ok).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe('/snapshot.json');
    const parsed = JSON.parse(writes[0]!.content) as Record<string, unknown>;
    expect(parsed.schema).toBe('rsi-admin-snapshot-v1');
    expect((parsed.health as { health: string }).health).toBe('HEALTHY');
    expect(((parsed.cost as { today: { ruleResolved: number } }).today).ruleResolved).toBe(1);
    expect(publisher.publishes()).toBe(1);
  });

  it('RSI_PUBLISHER_FAILURE_IS_CONTAINED：写失败不抛出（控制器不因发布失败崩溃）', async () => {
    const publisher = createAdminSnapshotPublisher({
      path: '/snapshot.json',
      write: async () => {
        throw new Error('EACCES');
      },
      ledger: createRsiCostLedger(),
      healthProvider: () => health,
      usageProvider: usage,
    });
    expect(await publisher.publishOnce()).toEqual({ ok: false, bytes: 0 });
    expect(publisher.publishes()).toBe(0);
  });

  it('RSI_PUBLISHER_START_IS_IDEMPOTENT：重复 start 不创建第二个 timer；stop 清理', () => {
    let handler: (() => void) | null = null;
    let timers = 0;
    const publisher = createAdminSnapshotPublisher({
      path: '/snapshot.json',
      write: async () => {},
      ledger: createRsiCostLedger(),
      healthProvider: () => health,
      usageProvider: usage,
      intervalMs: 60_000,
      setIntervalImpl: (fn) => {
        timers += 1;
        handler = fn;
        return 'timer-1';
      },
      clearIntervalImpl: () => {
        handler = null;
      },
    });
    publisher.start();
    publisher.start();
    expect(timers).toBe(1);
    expect(handler).not.toBeNull();
    publisher.stop();
    expect(handler).toBeNull();

    expect(RSI_ADMIN_SNAPSHOT_PUBLISHER_BOUNDARY.writesOnlyOwnArtifact).toBe(true);
    expect(RSI_ADMIN_SNAPSHOT_PUBLISHER_BOUNDARY.writesDatabase).toBe(false);
    expect(RSI_ADMIN_SNAPSHOT_PUBLISHER_BOUNDARY.performsExternalWrite).toBe(false);
    expect(RSI_ADMIN_SNAPSHOT_PUBLISHER_BOUNDARY.readsCredentials).toBe(false);
    expect(RSI_ADMIN_SNAPSHOT_PUBLISHER_BOUNDARY.idempotentStart).toBe(true);
  });
});
