/**
 * HISTORICAL_RECOVERY_SCAN_V1 / AUDIT-3 CHANGE 2 —— durable ownership / fencing（真实 PostgreSQL）
 * ---------------------------------------------------------------------------
 * 审计要求的最小矩阵：
 *   ① A claim 成功、B claim 失败 ⇒ **B 调 execution port 必须 BLOCK**，checkpoint 不变化；
 *   ② A 租约过期 ⇒ B 经**正式 reclaim** 接管，并从 durable checkpoint 续跑到 COMPLETED；
 *   ③ B reclaim 之后，stale A 再写 checkpoint ⇒ **条件更新 0 行（FENCED）**，DB 不被旧 worker 覆盖；
 *   ④ production execution port 必须**消费合法 ownership**（无 ownerRef → BLOCK；未认领则先自证认领）。
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { compileAgentGoal } from '../services/agent-goal/goal-compiler';
import { validateAgentGoalDraft } from '../services/agent-goal/goal-validator';
import {
  advanceRecoveryScanShard,
  claimRecoveryScanRun,
  createOrGetRecoveryScan,
  loadRecoveryScanById,
  reclaimRecoveryScanLease,
} from '../services/historical-scan';
import { evaluateCustomsHistoricalBatch } from '../services/historical-scan/customs-historical-pipeline';
import { createHistoricalScanExecutionPort } from '../services/historical-scan/scan-execution-port';

const prisma = new PrismaClient();

const ORG = 'c0ffee00-0000-4000-8000-00000000009a';
const USER = 'c0ffee00-0000-4000-8000-0000000000f9';
const INTENT = '检查我过去 5 年的关税损失，能追回的全部处理';
const NOW = new Date('2026-10-08T00:00:00.000Z');
const REQUESTED_FROM = '2021-10-08';
const REQUESTED_TO = '2026-10-08';
const SOURCE_FROM = '2025-10-08';

const ingestPort = {
  async ingest({ records }: { records: readonly unknown[] }) {
    const batch = evaluateCustomsHistoricalBatch(records as never);
    return { accepted: batch.summary.scanned, rejected: 0, eligibleFound: batch.summary.claimReady };
  },
};

function record(entryNumber: string) {
  return {
    entryNumber,
    scope: { organizationId: ORG, platformAccountId: 'acct-fence' },
    hts: '8471.30.0100',
    jurisdiction: 'US',
    entryDate: '2025-01-01',
    liquidationDate: '2025-06-01',
    exportDate: '2026-06-01',
    destructionDate: null,
    evidenceChain: { chainStatus: 'COMPLETE', missing: [], partial: [], lowConfidence: [] },
    counterpartMatch: { status: 'EXACT' },
    verifiedDeadlinePolicy: {
      policyId: 'us-drawback-v1',
      policyVersion: '1.0.0',
      anchorField: 'exportDate',
      daysFromAnchor: 1825,
      verification: 'LEGAL_VERIFIED',
    },
    requestFiling: false,
    now: NOW,
    historicalWindow: { blocksClaimReady: false, reasonCodes: ['FULL_COVERAGE'] },
  };
}

function pagePort(seen: string[]) {
  return {
    async fetchPage({ shard }: { shard: { key: string } }) {
      seen.push(shard.key);
      return {
        records: [record('FENCE-' + shard.key)],
        nextCursor: null,
        coverageFrom: SOURCE_FROM,
        coverageTo: REQUESTED_TO,
        coverageStatus: 'SOURCE_LIMITED' as const,
      };
    },
  };
}

async function seedScan(intent: string) {
  const compiled = compileAgentGoal({ text: intent });
  if (!compiled.ok) throw new Error('compile failed');
  const validated = validateAgentGoalDraft({
    draft: compiled.draft,
    context: { organizationId: ORG, actorUserId: USER, now: NOW },
  });
  const goalId = validated.goalId + '-fence-' + Date.now().toString(36);
  await prisma.agentGoal.create({
    data: {
      id: goalId,
      organizationId: ORG,
      createdBy: USER,
      rawUserIntent: intent,
      normalizedGoal: { version: validated.version, goalDigest: validated.goalDigest },
      status: 'ADMITTED',
      createdAt: NOW,
      updatedAt: NOW,
    },
  });
  const created = await createOrGetRecoveryScan(prisma, {
    organizationId: ORG,
    goalId,
    goalDigest: validated.goalDigest,
    domain: 'CUSTOMS',
    provider: 'CBP',
    platformAccountId: null,
    requestedFrom: REQUESTED_FROM,
    requestedTo: REQUESTED_TO,
    effectiveFrom: SOURCE_FROM,
    effectiveTo: REQUESTED_TO,
    requestedMonths: 60,
  });
  return { scanId: created.row.id, taskKey: 'task:recovery:CUSTOMS:' + created.row.dedupeKey };
}

beforeAll(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "RecoveryScanRun", "AgentGoalRun", "AgentGoal", "AuditLog", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: 'phase12-fence', slug: 'phase12-fence' } });
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE "RecoveryScanRun" CASCADE;');
  await prisma.agentGoal.deleteMany({});
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('PHASE 12 · durable ownership / fencing（AUDIT-3 CHANGE 2）', () => {
  it('① A 已持有租约 ⇒ B 调 execution port 必须 BLOCK，且 checkpoint 不变化', async () => {
    const { scanId, taskKey } = await seedScan(INTENT + '，A 持有');
    await claimRecoveryScanRun(prisma, {
      organizationId: ORG,
      scanId,
      leaseOwner: 'worker-a',
      leaseExpiresAt: new Date(NOW.getTime() + 600_000),
      now: NOW,
    });
    const before = await loadRecoveryScanById(prisma, { organizationId: ORG, scanId });

    const seen: string[] = [];
    const blocking = await createHistoricalScanExecutionPort(prisma).run({
      organizationId: ORG,
      taskKey,
      ownerRef: 'worker-b',
      pagePort: pagePort(seen),
      ingestPort,
      now: () => NOW,
    });
    expect(blocking.blocked).toBe(true);
    expect(blocking.reasonCodes).toContain('RECOVERY_SCAN_LEASE_NOT_HELD');
    expect(seen).toHaveLength(0); // 未取任何分片

    const after = await loadRecoveryScanById(prisma, { organizationId: ORG, scanId });
    expect(after!.nextShardIndex).toBe(before!.nextShardIndex);
    expect(after!.recordsScanned).toBe(before!.recordsScanned);
    expect(after!.leaseOwner).toBe('worker-a');
  });

  it('② A 租约过期 ⇒ B 经正式 reclaim 接管并从 durable checkpoint 续跑到 COMPLETED', async () => {
    const { scanId, taskKey } = await seedScan(INTENT + '，过期接管');
    // A 先推进一半并留下 durable checkpoint，随后租约过期（进程消失）
    await claimRecoveryScanRun(prisma, {
      organizationId: ORG,
      scanId,
      leaseOwner: 'worker-a',
      leaseExpiresAt: new Date(NOW.getTime() + 1_000),
      now: NOW,
    });
    const seen: string[] = [];
    const interrupted = await createHistoricalScanExecutionPort(prisma).run({
      organizationId: ORG,
      taskKey,
      ownerRef: 'worker-a',
      pagePort: pagePort(seen),
      ingestPort,
      maxPages: 2,
      now: () => NOW,
    });
    expect(interrupted.status).toBe('PARTIAL');
    const checkpoint = await loadRecoveryScanById(prisma, { organizationId: ORG, scanId });
    expect(checkpoint!.leaseOwner).toBe('worker-a');

    // 租约过期后由 B 接管（正式 reclaim：CAS on expired lease），并续跑到完成
    const later = new Date(NOW.getTime() + 600_000);
    const resumed = await createHistoricalScanExecutionPort(prisma).run({
      organizationId: ORG,
      taskKey,
      ownerRef: 'worker-b',
      pagePort: pagePort(seen),
      ingestPort,
      now: () => later,
    });
    expect(resumed.status).toBe('COMPLETED');
    expect(resumed.scanId).toBe(scanId);
    expect(new Set(seen).size).toBe(seen.length); // 分片零重复
    const done = await loadRecoveryScanById(prisma, { organizationId: ORG, scanId });
    expect(done!.status).toBe('COMPLETED');
    expect(done!.leaseOwner).toBeNull(); // finish 释放租约
  });

  it('③ B 接管后 stale A 写 checkpoint ⇒ 条件更新 0 行（FENCED），DB 不被旧 worker 覆盖', async () => {
    const { scanId } = await seedScan(INTENT + '，stale 写入');
    await claimRecoveryScanRun(prisma, {
      organizationId: ORG,
      scanId,
      leaseOwner: 'worker-a',
      leaseExpiresAt: new Date(NOW.getTime() + 1_000),
      now: NOW,
    });
    // B 通过**正式 reclaim**（CAS on expired lease）接管 —— claim 只接受 CREATED，这里必须用 reclaim
    const later = new Date(NOW.getTime() + 2_000);
    const reclaimed = await reclaimRecoveryScanLease(prisma, {
      organizationId: ORG,
      scanId,
      leaseOwner: 'worker-b',
      leaseExpiresAt: new Date(NOW.getTime() + 600_000),
      now: later,
    });
    expect(reclaimed).not.toBeNull();
    const before = await loadRecoveryScanById(prisma, { organizationId: ORG, scanId });
    expect(before!.leaseOwner).toBe('worker-b');

    // stale A 试图推进检查点（携带自己的 owner）⇒ 被 fencing 拒绝
    await expect(
      advanceRecoveryScanShard(prisma, {
        organizationId: ORG,
        scanId,
        shardIndex: 0,
        shardKey: 'stale-a',
        cursor: null,
        recordsScanned: 99,
        expectedLeaseOwner: 'worker-a',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'RECOVERY_SCAN_LEASE_FENCED' });

    const after = await loadRecoveryScanById(prisma, { organizationId: ORG, scanId });
    expect(after!.recordsScanned).toBe(before!.recordsScanned); // 未被覆盖
    expect(after!.nextShardIndex).toBe(before!.nextShardIndex);
    expect(after!.leaseOwner).toBe('worker-b');
  });

  it('④ execution port 必须消费合法 ownership：缺 ownerRef → BLOCK；未认领则先自证认领后才推进', async () => {
    const { scanId, taskKey } = await seedScan(INTENT + '，ownership 前置');

    // 缺 ownerRef：直接 BLOCK，且不产生任何写
    const noOwner = await createHistoricalScanExecutionPort(prisma).run({
      organizationId: ORG,
      taskKey,
      ownerRef: '',
      pagePort: pagePort([]),
      ingestPort,
      now: () => NOW,
    });
    expect(noOwner.blocked).toBe(true);
    expect(noOwner.reasonCodes).toContain('RECOVERY_SCAN_OWNER_REQUIRED');
    const untouched = await loadRecoveryScanById(prisma, { organizationId: ORG, scanId });
    expect(untouched!.status).toBe('CREATED');
    expect(untouched!.leaseOwner).toBeNull();

    // 合法 ownership：CREATED 时由端口自己 claim（唯一赢家）后推进
    const executed = await createHistoricalScanExecutionPort(prisma).run({
      organizationId: ORG,
      taskKey,
      ownerRef: 'worker-a',
      pagePort: pagePort([]),
      ingestPort,
      now: () => NOW,
    });
    expect(executed.status).toBe('COMPLETED');
    const done = await loadRecoveryScanById(prisma, { organizationId: ORG, scanId });
    expect(done!.status).toBe('COMPLETED');
  });
});
