// HISTORICAL_RECOVERY_SCAN_V1 / PHASE 2 + 6 + 9（真实 PostgreSQL）
// 覆盖：确定性身份 / 幂等 create-or-get / 租户隔离 / 身份不可改写 / 并发 claim /
//       分片检查点与 crash resume / 幂等重放 / coverage tracking / customer-safe summary。

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  buildRecoveryScanIdentity,
  buildScanSummaryView,
  claimRecoveryScanRun,
  createOrGetRecoveryScan,
  finishRecoveryScan,
  loadRecoveryScanScope,
  runHistoricalBackfill,
  scanCoverageIsFull,
  setRecoveryScanCoverage,
  verifyRecoveryScanDigest,
  type BackfillPage,
  type BackfillPagePort,
} from '../services/historical-scan';

const prisma = new PrismaClient();

const ORG = 'c0ffee00-0000-4000-8000-00000000001a';
const ORG_B = 'c0ffee00-0000-4000-8000-00000000001b';
const USER = 'c0ffee00-0000-4000-8000-0000000000f2';
const GOAL_DIGEST = 'd'.repeat(64);
const GOAL_ID = 'goal-' + GOAL_DIGEST.slice(0, 24);
const FROM = '2021-10-08';
const TO = '2026-10-08';

async function truncate(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "RecoveryScanRun", "AgentGoalRun", "AgentGoal", "AuditLog", "Membership", "User", "Organization" CASCADE;',
  );
}

async function seedOrg(organizationId: string, slug: string): Promise<void> {
  await prisma.organization.create({ data: { id: organizationId, name: slug, slug } });
}

async function seedGoal(organizationId: string, goalId = GOAL_ID, digest = GOAL_DIGEST): Promise<string> {
  await prisma.agentGoal.create({
    data: {
      id: goalId,
      organizationId,
      createdBy: USER,
      rawUserIntent: '检查我过去 5 年的关税损失',
      normalizedGoal: { version: 'agent-goal/v1', goalDigest: digest },
      status: 'ADMITTED',
      createdAt: new Date('2026-10-08T00:00:00.000Z'),
      updatedAt: new Date('2026-10-08T00:00:00.000Z'),
    },
  });
  return goalId;
}

function scanInput(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: ORG,
    goalId: GOAL_ID,
    goalDigest: GOAL_DIGEST,
    domain: 'CUSTOMS',
    provider: 'CBP',
    platformAccountId: null,
    requestedFrom: FROM,
    requestedTo: TO,
    effectiveFrom: FROM,
    effectiveTo: TO,
    requestedMonths: 60,
    ...overrides,
  } as Parameters<typeof createOrGetRecoveryScan>[1];
}

beforeAll(async () => {
  await truncate();
  await seedOrg(ORG, 'scan-org');
  await seedOrg(ORG_B, 'scan-org-b');
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE "RecoveryScanRun" CASCADE;');
  await prisma.agentGoal.deleteMany({});
  await seedGoal(ORG);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('PHASE 2 · durable RecoveryScanRun', () => {
  it('身份确定性：同输入 → 同 dedupeKey / scanDigest；不含 transient timestamp', () => {
    const a = buildRecoveryScanIdentity({
      goalDigest: GOAL_DIGEST,
      domain: 'CUSTOMS',
      provider: 'CBP',
      platformAccountId: null,
      effectiveFrom: FROM,
      effectiveTo: TO,
      requestedMonths: 60,
    });
    const b = buildRecoveryScanIdentity({
      goalDigest: GOAL_DIGEST,
      domain: 'customs',
      provider: 'cbp',
      platformAccountId: null,
      effectiveFrom: new Date(FROM + 'T23:59:59.000Z'),
      effectiveTo: new Date(TO + 'T00:00:01.000Z'),
      requestedMonths: 60,
    });
    expect(a.dedupeKey).toBe(b.dedupeKey);
    expect(a.scanDigest).toBe(b.scanDigest);
    expect(a.dedupeKey).toContain('2021-10-08');
  });

  it('create-or-get：同一范围重复创建不产生第二个 scan', async () => {
    const first = await createOrGetRecoveryScan(prisma, scanInput());
    const second = await createOrGetRecoveryScan(prisma, scanInput());
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(await prisma.recoveryScanRun.count()).toBe(1);
  });

  it('租户隔离：异租户 goal 拒绝创建；异租户按 dedupeKey 读取返回 null', async () => {
    const created = await createOrGetRecoveryScan(prisma, scanInput());
    await expect(
      createOrGetRecoveryScan(prisma, scanInput({ organizationId: ORG_B })),
    ).rejects.toThrowError(/目标不属于该组织/);

    const crossTenant = await loadRecoveryScanScope(prisma, {
      organizationId: ORG_B,
      dedupeKey: created.row.dedupeKey,
    });
    expect(crossTenant).toBeNull();

    const sameTenant = await loadRecoveryScanScope(prisma, {
      organizationId: ORG,
      dedupeKey: created.row.dedupeKey,
    });
    expect(sameTenant?.id).toBe(created.row.id);
  });

  it('身份不可改写：改 dedupeKey / effectiveFrom 被数据库触发器拒绝', async () => {
    // 自包含场景（与生产迁移同一条 DB 触发器路径）
    await truncate();
    const org = 'c0ffee00-0000-4000-8000-0000000000ad';
    const digest = 'a'.repeat(64);
    const goalId = 'goal-' + digest.slice(0, 24);
    await seedOrg(org, 'scan-org-immutable');
    await seedGoal(org, goalId, digest);
    const created = await createOrGetRecoveryScan(prisma, {
      ...scanInput(),
      organizationId: org,
      goalId,
      goalDigest: digest,
    });
    // 直接用 SQL 改身份列：DB 级触发器必须拒绝（不依赖 ORM 行为）
    await expect(
      prisma.$executeRawUnsafe(
        'UPDATE "RecoveryScanRun" SET "dedupeKey" = $1 WHERE "id" = $2',
        'scan:v1:tampered',
        created.row.id,
      ),
    ).rejects.toThrowError(/RECOVERY_SCAN_IDENTITY_IMMUTABLE/);
    await expect(
      prisma.$executeRawUnsafe(
        'UPDATE "RecoveryScanRun" SET "effectiveFrom" = $1 WHERE "id" = $2',
        new Date('2020-01-01T00:00:00.000Z'),
        created.row.id,
      ),
    ).rejects.toThrowError(/RECOVERY_SCAN_IDENTITY_IMMUTABLE/);
    // 进度/覆盖列仍可更新（不是"整表只读"）
    await prisma.$executeRawUnsafe('UPDATE "RecoveryScanRun" SET "recordsScanned" = 5 WHERE "id" = $1', created.row.id);
    const after = await prisma.recoveryScanRun.findUnique({
      where: { organizationId_id: { organizationId: org, id: created.row.id } },
    });
    expect(after?.recordsScanned).toBe(5);
    // 恢复本文件后续用例依赖的租户基线
    await truncate();
    await seedOrg(ORG, 'scan-org');
    await seedOrg(ORG_B, 'scan-org-b');
    await seedGoal(ORG);
  });

  it('并发 claim：只有第一个 worker 能抢到（CREATED → RUNNING）', async () => {
    const created = await createOrGetRecoveryScan(prisma, scanInput());
    const [a, b] = await Promise.all([
      claimRecoveryScanRun(prisma, {
        organizationId: ORG,
        scanId: created.row.id,
        leaseOwner: 'worker-a',
        leaseExpiresAt: new Date(Date.now() + 60_000),
      }),
      claimRecoveryScanRun(prisma, {
        organizationId: ORG,
        scanId: created.row.id,
        leaseOwner: 'worker-b',
        leaseExpiresAt: new Date(Date.now() + 60_000),
      }),
    ]);
    const claimed = [a, b].filter((row) => row !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.status).toBe('RUNNING');
  });

  it('终态约束：未完成不得写 completedAt；finish 只接受终态', async () => {
    const created = await createOrGetRecoveryScan(prisma, scanInput());
    await expect(
      prisma.recoveryScanRun.update({
        where: { organizationId_id: { organizationId: ORG, id: created.row.id } },
        data: { completedAt: new Date() },
      }),
    ).rejects.toThrow();
    await expect(
      finishRecoveryScan(prisma, { organizationId: ORG, scanId: created.row.id, status: 'RUNNING' }),
    ).rejects.toThrowError(/只有终态/);
    const finished = await finishRecoveryScan(prisma, {
      organizationId: ORG,
      scanId: created.row.id,
      status: 'COMPLETED',
    });
    expect(finished.completedAt).not.toBeNull();
  });

  it('digest 篡改检测：DB 原始写入被改则拒绝使用范围', async () => {
    const created = await createOrGetRecoveryScan(prisma, scanInput());
    expect(verifyRecoveryScanDigest(created.row)).toBe(true);
    expect(verifyRecoveryScanDigest({ ...created.row, goalDigest: 'x'.repeat(64) })).toBe(false);
  });
});

describe('PHASE 6 · historical backfill（分片 / 检查点 / crash resume / 幂等）', () => {
  function fakePorts(pagesPerShard = 2) {
    const ingestCalls: string[] = [];
    const fetchCalls: string[] = [];
    const pagePort: BackfillPagePort = {
      async fetchPage({ shard, cursor }): Promise<BackfillPage> {
        const pageIndex = cursor === null ? 0 : Number(cursor);
        fetchCalls.push(shard.key + '#' + pageIndex);
        const next = pageIndex + 1 < pagesPerShard ? String(pageIndex + 1) : null;
        return {
          records: [1, 2, 3],
          nextCursor: next,
          coverageFrom: '2022-04-08',
          coverageTo: '2026-10-08',
          coverageStatus: 'SOURCE_LIMITED',
        };
      },
    };
    const ingestPort = {
      async ingest({ shard, records }: { shard: { key: string }; records: readonly unknown[] }) {
        ingestCalls.push(shard.key);
        return { accepted: records.length, rejected: 0, opportunitiesFound: 0, eligibleFound: 0 };
      },
    };
    return { pagePort, ingestPort, ingestCalls, fetchCalls };
  }

  it('5 年区间 → 60 个月度分片；执行完成为 COMPLETED 且覆盖为 SOURCE_LIMITED', async () => {
    const created = await createOrGetRecoveryScan(prisma, scanInput());
    const ports = fakePorts(1);
    const result = await runHistoricalBackfill(prisma, {
      organizationId: ORG,
      scanId: created.row.id,
      ...ports,
    });
    expect(result.status).toBe('COMPLETED');
    expect(result.shardsTotal).toBe(60);
    expect(result.shardsCompleted).toBe(60);
    const row = await prisma.recoveryScanRun.findUnique({
      where: { organizationId_id: { organizationId: ORG, id: created.row.id } },
    });
    expect(row?.recordsScanned).toBe(180);
    expect(row?.sourceCoverageStatus).toBe('SOURCE_LIMITED');
    const summary = buildScanSummaryView(row!);
    expect(scanCoverageIsFull(summary)).toBe(false);
    expect(summary.disclaimerCodes).toContain('COVERAGE_NOT_FULL');
    expect(summary.claimsFiled).toBe(0);
    expect(summary.filingPerformed).toBe(false);
  });

  it('crash resume：预算中断后再次执行从下一个分片继续，且不重复处理已完成的页', async () => {
    const created = await createOrGetRecoveryScan(prisma, scanInput({ effectiveFrom: '2026-07-08' }));
    const ports = fakePorts(2);
    const first = await runHistoricalBackfill(prisma, {
      organizationId: ORG,
      scanId: created.row.id,
      ...ports,
      maxPages: 5,
    });
    expect(first.status).toBe('PARTIAL');
    const processedFirstRun = [...ports.fetchCalls];
    expect(processedFirstRun.length).toBe(5);

    const second = await runHistoricalBackfill(prisma, {
      organizationId: ORG,
      scanId: created.row.id,
      ...ports,
    });
    expect(second.status).toBe('COMPLETED');
    const all = [...ports.fetchCalls];
    const unique = new Set(all);
    expect(unique.size).toBe(all.length); // 没有任何页被重复处理
    expect(all.length).toBeGreaterThan(processedFirstRun.length);
  });

  it('幂等重放：已完成的 scan 再执行不产生任何 ingest 调用', async () => {
    const created = await createOrGetRecoveryScan(prisma, scanInput({ effectiveFrom: '2026-09-08' }));
    const ports = fakePorts(1);
    const first = await runHistoricalBackfill(prisma, { organizationId: ORG, scanId: created.row.id, ...ports });
    expect(first.status).toBe('COMPLETED');
    const callsAfterFirst = ports.ingestCalls.length;
    const replay = await runHistoricalBackfill(prisma, { organizationId: ORG, scanId: created.row.id, ...ports });
    expect(replay.status).toBe('COMPLETED');
    expect(ports.ingestCalls.length).toBe(callsAfterFirst);
  });

  it('覆盖更新：coverage 只能通过端口上报的实际上限写入（不得按请求推断）', async () => {
    const created = await createOrGetRecoveryScan(prisma, scanInput());
    const row = await setRecoveryScanCoverage(prisma, {
      organizationId: ORG,
      scanId: created.row.id,
      coverageStart: '2025-01-08',
      coverageEnd: '2026-10-08',
      sourceCoverageStatus: 'SOURCE_LIMITED',
    });
    const summary = buildScanSummaryView(row);
    expect(summary.coverage).toBe('SOURCE_LIMITED');
    expect(summary.requestedFrom).toBe(FROM);
    expect(summary.effectiveRangeClamped).toBe(false);
    expect(scanCoverageIsFull(summary)).toBe(false);
  });
});
