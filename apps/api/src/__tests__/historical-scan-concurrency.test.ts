// HISTORICAL_RECOVERY_SCAN_V1 / PHASE 12 —— 多 worker 并发 / 崩溃恢复 / 陈旧租约 / 检查点续跑 / 幂等
// ---------------------------------------------------------------------------
// 单元边界（不新增 runtime / scheduler / queue）：
//   ① 并发认领：只有 CREATED → RUNNING 的 CAS 胜者能认领（唯一赢家，败者不推进任何检查点）；
//   ② 崩溃恢复：进程内状态全丢后，新 worker 从 **durable checkpoint** 续跑并完成，分片不重复；
//   ③ 幂等：COMPLETED 后重复执行 → 零分片再处理、零额外写；
//   ④ 陈旧租约（诚实边界）：scan 级**没有** lease reclaim / fencing —— RUNNING 不能被再次认领，
//      过期租约也不会自动回收；恢复语义由既有 runtime task-lease reconcile 承担，
//      生产级 durable/atomic 队列仍记为 PRODUCTION_DURABLE_QUEUE_REQUIRED（不在此 PHASE 解决）。

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  claimRecoveryScanRun,
  createOrGetRecoveryScan,
  loadRecoveryScanById,
  runHistoricalBackfill,
} from '../services/historical-scan';
import { evaluateCustomsHistoricalBatch } from '../services/historical-scan/customs-historical-pipeline';
import { compileAgentGoal } from '../services/agent-goal/goal-compiler';
import { validateAgentGoalDraft } from '../services/agent-goal/goal-validator';

const prisma = new PrismaClient();

const ORG = 'c0ffee00-0000-4000-8000-00000000007a';
const USER = 'c0ffee00-0000-4000-8000-0000000000f7';
const INTENT = '检查我过去 5 年的关税损失，能追回的全部处理';
const NOW = new Date('2026-10-08T00:00:00.000Z');
const REQUESTED_FROM = '2021-10-08';
const REQUESTED_TO = '2026-10-08';

const COMPLETE_CHAIN = { chainStatus: 'COMPLETE', missing: [], partial: [], lowConfidence: [] } as never;

function syntheticRecord(entryNumber: string) {
  return {
    entryNumber,
    scope: { organizationId: ORG, platformAccountId: 'acct-conc' },
    hts: '8471.30.0100',
    jurisdiction: 'US',
    entryDate: '2025-01-01',
    liquidationDate: '2025-06-01',
    exportDate: '2026-06-01',
    destructionDate: null,
    evidenceChain: COMPLETE_CHAIN,
    counterpartMatch: { status: 'EXACT' } as never,
    verifiedDeadlinePolicy: {
      policyId: 'us-drawback-v1',
      policyVersion: '1.0.0',
      anchorField: 'exportDate' as const,
      daysFromAnchor: 1825,
      verification: 'LEGAL_VERIFIED' as const,
    },
    requestFiling: false,
    now: NOW,
    historicalWindow: { blocksClaimReady: false, reasonCodes: ['FULL_COVERAGE'] },
  };
}

const ingestPort = {
  async ingest({ records }: { records: readonly unknown[] }) {
    const batch = evaluateCustomsHistoricalBatch(records as never);
    return { accepted: batch.summary.scanned, rejected: 0, eligibleFound: batch.summary.claimReady };
  },
};

async function seedScan() {
  const compiled = compileAgentGoal({ text: INTENT });
  if (!compiled.ok) throw new Error('compile failed');
  const validated = validateAgentGoalDraft({
    draft: compiled.draft,
    context: { organizationId: ORG, actorUserId: USER, now: NOW },
  });
  await prisma.agentGoal.create({
    data: {
      id: validated.goalId,
      organizationId: ORG,
      createdBy: USER,
      rawUserIntent: INTENT,
      normalizedGoal: { version: validated.version, goalDigest: validated.goalDigest },
      status: 'ADMITTED',
      createdAt: NOW,
      updatedAt: NOW,
    },
  });
  const created = await createOrGetRecoveryScan(prisma, {
    organizationId: ORG,
    goalId: validated.goalId,
    goalDigest: validated.goalDigest,
    domain: 'CUSTOMS',
    provider: 'CBP',
    platformAccountId: null,
    requestedFrom: REQUESTED_FROM,
    requestedTo: REQUESTED_TO,
    effectiveFrom: REQUESTED_FROM,
    effectiveTo: REQUESTED_TO,
    requestedMonths: 60,
  });
  return created;
}

function trackingPagePort(seen: string[]) {
  return {
    async fetchPage({ shard }: { shard: { key: string } }) {
      seen.push(shard.key);
      return {
        records: [syntheticRecord('ENTRY-C12-' + shard.key)],
        nextCursor: null,
        coverageFrom: '2025-10-08',
        coverageTo: REQUESTED_TO,
        coverageStatus: 'SOURCE_LIMITED' as const,
      };
    },
  };
}

beforeAll(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "RecoveryScanRun", "AgentGoalRun", "AgentGoal", "AuditLog", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: 'phase12', slug: 'phase12' } });
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE "RecoveryScanRun" CASCADE;');
  await prisma.agentGoal.deleteMany({});
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('PHASE 12 · 并发 / 崩溃恢复 / 陈旧租约 / 幂等（真实 PostgreSQL）', () => {
  it('多 worker 并发认领同一 scan：CAS 唯一赢家，败者不推进任何检查点', async () => {
    const created = await seedScan();
    const expiry = new Date(NOW.getTime() + 60_000);

    const [a, b] = await Promise.all([
      claimRecoveryScanRun(prisma, {
        organizationId: ORG,
        scanId: created.row.id,
        leaseOwner: 'worker-a',
        leaseExpiresAt: expiry,
        now: NOW,
      }),
      claimRecoveryScanRun(prisma, {
        organizationId: ORG,
        scanId: created.row.id,
        leaseOwner: 'worker-b',
        leaseExpiresAt: expiry,
        now: NOW,
      }),
    ]);

    const winners = [a, b].filter((row) => row !== null);
    expect(winners).toHaveLength(1);
    const row = await loadRecoveryScanById(prisma, { organizationId: ORG, scanId: created.row.id });
    expect(row!.status).toBe('RUNNING');
    expect(['worker-a', 'worker-b']).toContain(row!.leaseOwner);
    // 败者没有产生任何检查点推进
    expect(row!.recordsScanned).toBe(0);
    expect(row!.nextShardIndex).toBe(0);

    // RUNNING 不可被再次认领（第三个 worker 也不会成为第二执行者）
    const again = await claimRecoveryScanRun(prisma, {
      organizationId: ORG,
      scanId: created.row.id,
      leaseOwner: 'worker-c',
      leaseExpiresAt: expiry,
      now: NOW,
    });
    expect(again).toBeNull();
  });

  it('崩溃恢复：新 worker 从 durable checkpoint 续跑并完成，分片不重复', async () => {
    const created = await seedScan();
    await claimRecoveryScanRun(prisma, {
      organizationId: ORG,
      scanId: created.row.id,
      leaseOwner: 'worker-a',
      leaseExpiresAt: new Date(NOW.getTime() + 60_000),
      now: NOW,
    });

    const seen: string[] = [];
    // worker A：预算耗尽即中断（进程内状态全部丢弃，模拟崩溃）
    const first = await runHistoricalBackfill(prisma, {
      organizationId: ORG,
      scanId: created.row.id,
      pagePort: trackingPagePort(seen),
      ingestPort,
      maxPages: 2,
    });
    expect(first.status).toBe('PARTIAL');
    expect(seen.length).toBe(2);

    // durable checkpoint 必须已落库（DB 状态仍是 RUNNING，落的是 checkpoint 而不是 PARTIAL 终态）
    const mid = await loadRecoveryScanById(prisma, { organizationId: ORG, scanId: created.row.id });
    expect(mid!.status).toBe('RUNNING');
    expect(mid!.nextShardIndex).toBe(2);

    // worker B（不同 leaseOwner / 新进程）：不重新认领，直接从 durable checkpoint 续跑
    const resumed = await runHistoricalBackfill(prisma, {
      organizationId: ORG,
      scanId: created.row.id,
      pagePort: trackingPagePort(seen),
      ingestPort,
    });
    expect(resumed.status).toBe('COMPLETED');
    expect(new Set(seen).size).toBe(seen.length); // 无分片重复处理

    const done = await loadRecoveryScanById(prisma, { organizationId: ORG, scanId: created.row.id });
    expect(done!.status).toBe('COMPLETED');
    expect(done!.recordsScanned).toBe(seen.length);
  });

  it('幂等：COMPLETED 后重复执行 → 零分片再处理、零额外行', async () => {
    const created = await seedScan();
    await claimRecoveryScanRun(prisma, {
      organizationId: ORG,
      scanId: created.row.id,
      leaseOwner: 'worker-a',
      leaseExpiresAt: new Date(NOW.getTime() + 60_000),
      now: NOW,
    });
    const seen: string[] = [];
    const done = await runHistoricalBackfill(prisma, {
      organizationId: ORG,
      scanId: created.row.id,
      pagePort: trackingPagePort(seen),
      ingestPort,
    });
    expect(done.status).toBe('COMPLETED');
    const callsAfterFirstRun = seen.length;
    const rowsAfterFirstRun = await prisma.recoveryScanRun.count();
    const snapshot = await loadRecoveryScanById(prisma, { organizationId: ORG, scanId: created.row.id });

    // 重复执行（重放 / 重启后的再次调度）
    const replay = await runHistoricalBackfill(prisma, {
      organizationId: ORG,
      scanId: created.row.id,
      pagePort: trackingPagePort(seen),
      ingestPort,
    });
    expect(replay.status).toBe('COMPLETED');
    expect(seen.length).toBe(callsAfterFirstRun); // 未再取任何分片
    expect(await prisma.recoveryScanRun.count()).toBe(rowsAfterFirstRun);
    const after = await loadRecoveryScanById(prisma, { organizationId: ORG, scanId: created.row.id });
    expect(after!.recordsScanned).toBe(snapshot!.recordsScanned);
    expect(after!.nextShardIndex).toBe(snapshot!.nextShardIndex);
  });

  it('陈旧租约（诚实边界）：scan 级无 reclaim / fencing —— RUNNING 不被过期租约回收', async () => {
    const created = await seedScan();
    const expiredAt = new Date(NOW.getTime() - 60_000); // 早已过期
    await claimRecoveryScanRun(prisma, {
      organizationId: ORG,
      scanId: created.row.id,
      leaseOwner: 'worker-dead',
      leaseExpiresAt: expiredAt,
      now: new Date(NOW.getTime() - 120_000),
    });
    const row = await loadRecoveryScanById(prisma, { organizationId: ORG, scanId: created.row.id });
    expect(row!.status).toBe('RUNNING');
    expect(row!.leaseOwner).toBe('worker-dead');

    // 认领只接受 CREATED：过期租约**不会**被自动回收（不存在第二套 lease 引擎）
    const reclaim = await claimRecoveryScanRun(prisma, {
      organizationId: ORG,
      scanId: created.row.id,
      leaseOwner: 'worker-recover',
      leaseExpiresAt: new Date(NOW.getTime() + 60_000),
      now: NOW,
    });
    expect(reclaim).toBeNull();

    // 边界声明（供审计）：scan 的崩溃/接管恢复依赖既有 runtime task-lease reconcile；
    // 生产级 durable/atomic 队列 = PRODUCTION_DURABLE_QUEUE_REQUIRED（未在本 PHASE 解决）。
    expect(row!.status).toBe('RUNNING');
  });
});
