// HISTORICAL_RECOVERY_SCAN_V1 / PHASE 13 —— 完整测试矩阵 B–G
// ---------------------------------------------------------------------------
//   B = range propagation（请求范围 → server 解析 → durable scope → 分片计划；caller 自报被忽略）
//   C = resume E2E（runtime 域步骤预算耗尽 → PARTIAL → 再次域步骤从 durable checkpoint 续跑 → COMPLETED）
//   D = coverage limitation（SOURCE_LIMITED 诚实标注 + 全量覆盖正向对照）
//   E = customs 全矩阵（四种 disposition + 三道 fail-closed 门）
//   F = tenant isolation E2E（跨租户一律 BLOCK，且不改动他租户 durable 行）
//   G = 外部动作/第二事实源恒为 false（跨矩阵最终不变式）
// 仅验证既有链路；不新增 runtime / scheduler / 事实源。

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  buildScanSummaryView,
  claimRecoveryScanRun,
  createOrGetRecoveryScan,
  loadRecoveryScanById,
  loadScanScopeForClaimedTask,
  planScanShards,
  resolveRecoveryWindow,
  scanCoverageIsFull,
} from '../services/historical-scan';
import {
  evaluateCustomsHistoricalBatch,
  evaluateCustomsHistoricalCandidate,
} from '../services/historical-scan/customs-historical-pipeline';
import { createHistoricalScanExecutionPort } from '../services/historical-scan/scan-execution-port';
import { compileAgentGoal } from '../services/agent-goal/goal-compiler';
import { validateAgentGoalDraft } from '../services/agent-goal/goal-validator';

const prisma = new PrismaClient();

const ORG = 'c0ffee00-0000-4000-8000-00000000008a';
const ORG_B = 'c0ffee00-0000-4000-8000-00000000008b';
const USER = 'c0ffee00-0000-4000-8000-0000000000f8';
const INTENT = '检查我过去 5 年的关税损失，能追回的全部处理';
const NOW = new Date('2026-10-08T00:00:00.000Z');
const REQUESTED_FROM = '2021-10-08';
const REQUESTED_TO = '2026-10-08';
const SOURCE_FROM = '2025-10-08';

const COMPLETE_CHAIN = { chainStatus: 'COMPLETE', missing: [], partial: [], lowConfidence: [] } as never;
const EXACT_MATCH = { status: 'EXACT' } as never;
const VERIFIED_POLICY = {
  policyId: 'us-drawback-v1',
  policyVersion: '1.0.0',
  anchorField: 'exportDate' as const,
  daysFromAnchor: 1825,
  verification: 'LEGAL_VERIFIED' as const,
};

type RecordKind = 'PERFECT' | 'NO_EVIDENCE' | 'SPECIAL_PROVISION';

function record(entryNumber: string, kind: RecordKind = 'PERFECT', overrides: Record<string, unknown> = {}) {
  return {
    entryNumber,
    scope: { organizationId: ORG, platformAccountId: 'acct-matrix' },
    hts: kind === 'SPECIAL_PROVISION' ? '9801.00.1012' : '8471.30.0100',
    jurisdiction: 'US',
    entryDate: '2025-01-01',
    liquidationDate: '2025-06-01',
    exportDate: '2026-06-01',
    destructionDate: null,
    evidenceChain: kind === 'NO_EVIDENCE' ? null : COMPLETE_CHAIN,
    counterpartMatch: EXACT_MATCH,
    verifiedDeadlinePolicy: VERIFIED_POLICY,
    requestFiling: false,
    now: NOW,
    historicalWindow: { blocksClaimReady: false, reasonCodes: ['FULL_COVERAGE'] },
    ...overrides,
  };
}

function resolveWindow(sourceFrom: string) {
  return resolveRecoveryWindow({
    domain: 'CUSTOMS',
    requestedFrom: REQUESTED_FROM,
    requestedTo: REQUESTED_TO,
    jurisdiction: 'US',
    sourceCoverageFrom: sourceFrom,
    sourceCoverageTo: REQUESTED_TO,
    policyWindow: {
      anchorField: 'exportDate',
      daysFromAnchor: 1825,
      verified: true,
      anchorDate: '2025-06-01',
    },
  });
}

async function seedScan(organizationId: string, effectiveFrom: string, months = 60, intent: string = INTENT) {
  const compiled = compileAgentGoal({ text: intent });
  if (!compiled.ok) throw new Error('compile failed');
  const validated = validateAgentGoalDraft({
    draft: compiled.draft,
    context: { organizationId, actorUserId: USER, now: NOW },
  });
  await prisma.agentGoal.create({
    data: {
      id: validated.goalId,
      organizationId,
      createdBy: USER,
      rawUserIntent: intent,
      normalizedGoal: { version: validated.version, goalDigest: validated.goalDigest },
      status: 'ADMITTED',
      createdAt: NOW,
      updatedAt: NOW,
    },
  });
  const created = await createOrGetRecoveryScan(prisma, {
    organizationId,
    goalId: validated.goalId,
    goalDigest: validated.goalDigest,
    domain: 'CUSTOMS',
    provider: 'CBP',
    platformAccountId: null,
    requestedFrom: REQUESTED_FROM,
    requestedTo: REQUESTED_TO,
    effectiveFrom,
    effectiveTo: REQUESTED_TO,
    requestedMonths: months,
  });
  return { created, taskKey: 'task:recovery:CUSTOMS:' + created.row.dedupeKey };
}

function pagePort(seen: string[], coverageStatus: 'FULL' | 'SOURCE_LIMITED' = 'SOURCE_LIMITED', coverageFrom = SOURCE_FROM) {
  return {
    async fetchPage({ shard }: { shard: { key: string } }) {
      seen.push(shard.key);
      return {
        records: [record('ENTRY-M13-' + shard.key)],
        nextCursor: null,
        coverageFrom,
        coverageTo: REQUESTED_TO,
        coverageStatus,
      };
    },
  };
}

const ingestPort = {
  async ingest({ records }: { records: readonly unknown[] }) {
    const batch = evaluateCustomsHistoricalBatch(records as never);
    return { accepted: batch.summary.scanned, rejected: 0, eligibleFound: batch.summary.claimReady };
  },
};

beforeAll(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "RecoveryScanRun", "AgentGoalRun", "AgentGoal", "AuditLog", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: 'matrix', slug: 'matrix' } });
  await prisma.organization.create({ data: { id: ORG_B, name: 'matrix-b', slug: 'matrix-b' } });
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE "RecoveryScanRun" CASCADE;');
  await prisma.agentGoal.deleteMany({});
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('PHASE 13 · 矩阵 B–G', () => {
  it('B · range propagation：请求范围 → server 解析 → durable scope → 分片计划（caller 自报被忽略）', async () => {
    const window = resolveWindow(SOURCE_FROM);
    expect(window.effectiveFrom).toBe(SOURCE_FROM);
    expect(window.coverage).toBe('SOURCE_LIMITED');

    const { created } = await seedScan(ORG, window.effectiveFrom);
    const loaded = await loadScanScopeForClaimedTask(prisma, {
      organizationId: ORG,
      dedupeKey: created.row.dedupeKey,
      assertedRange: { from: '1990-01-01', to: '2030-01-01', months: 999 },
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.scope.callerRangeTrusted).toBe(false);
    expect(loaded.scope.requestedMonths).toBe(60);
    expect(loaded.scope.effectiveFrom).toBe(SOURCE_FROM);

    // 分片计划按 **effective** 窗口（而不是请求的 5 年）展开
    const shards = planScanShards({ from: window.effectiveFrom, to: window.effectiveTo });
    expect(shards[0]!.from).toBe(SOURCE_FROM);
    expect(shards.every((shard) => shard.from >= SOURCE_FROM)).toBe(true);
  });

  it('C · resume E2E：域步骤预算耗尽 → PARTIAL → 再次域步骤从 durable checkpoint 续跑 → COMPLETED', async () => {
    const window = resolveWindow(SOURCE_FROM);
    const { created, taskKey } = await seedScan(ORG, window.effectiveFrom);
    await claimRecoveryScanRun(prisma, {
      organizationId: ORG,
      scanId: created.row.id,
      leaseOwner: 'runtime-a',
      leaseExpiresAt: new Date(NOW.getTime() + 60_000),
      now: NOW,
    });
    const port = createHistoricalScanExecutionPort(prisma);

    const seen: string[] = [];
    // 第一次域步骤：只给 2 页预算（等价于一次 tick 内把 scan 推进到一半）
    const first = await port.run({
      organizationId: ORG,
      taskKey,
      ownerRef: 'runtime-a',
      pagePort: pagePort(seen),
      ingestPort,
      maxPages: 2,
    } as never);
    // PARTIAL 不是 COMPLETED，因此 ok=false（但**不是** BLOCKED）
    expect(first.blocked).toBe(false);
    expect(first.status).toBe('PARTIAL');
    expect(seen.length).toBe(2);
    const mid = await loadRecoveryScanById(prisma, { organizationId: ORG, scanId: created.row.id });
    expect(mid!.status).toBe('RUNNING');
    expect(mid!.nextShardIndex).toBe(2);

    // 第二次域步骤（同一条链，新调用）：从 durable checkpoint 继续到完成
    const resumed = await port.run({
      organizationId: ORG,
      taskKey,
      ownerRef: 'runtime-a',
      pagePort: pagePort(seen),
      ingestPort,
    } as never);
    expect(resumed.status).toBe('COMPLETED');
    expect(resumed.scanId).toBe(created.row.id);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('D · coverage limitation：SOURCE_LIMITED 诚实标注，与 FULL 覆盖正向对照', async () => {
    // 负向：数据源只覆盖最近 1 年
    const limited = await (async () => {
      const window = resolveWindow(SOURCE_FROM);
      const { created, taskKey } = await seedScan(ORG, window.effectiveFrom);
      await claimRecoveryScanRun(prisma, {
        organizationId: ORG,
        scanId: created.row.id,
        leaseOwner: 'runtime-a',
        leaseExpiresAt: new Date(NOW.getTime() + 60_000),
        now: NOW,
      });
      await createHistoricalScanExecutionPort(prisma).run({
        organizationId: ORG,
        taskKey,
        ownerRef: 'runtime-a',
        pagePort: pagePort([]),
        ingestPort,
      } as never);
      return loadRecoveryScanById(prisma, { organizationId: ORG, scanId: created.row.id });
    })();
    const limitedSummary = buildScanSummaryView(limited!);
    expect(limitedSummary.coverage).toBe('SOURCE_LIMITED');
    expect(scanCoverageIsFull(limitedSummary)).toBe(false);
    expect(limitedSummary.disclaimerCodes).toContain('COVERAGE_NOT_FULL');
    expect(limitedSummary.requestedMonths).toBe(60);
    expect(limitedSummary.requestedFrom).toBe(REQUESTED_FROM);

    // 正向对照：数据源覆盖整个请求窗口 → FULL
    await prisma.$executeRawUnsafe('TRUNCATE "RecoveryScanRun" CASCADE;');
    await prisma.agentGoal.deleteMany({});
    const fullWindow = resolveWindow(REQUESTED_FROM);
    expect(fullWindow.coverage).toBe('FULL');
    const { created: fullScan, taskKey: fullTask } = await seedScan(ORG, fullWindow.effectiveFrom);
    await claimRecoveryScanRun(prisma, {
      organizationId: ORG,
      scanId: fullScan.row.id,
      leaseOwner: 'runtime-a',
      leaseExpiresAt: new Date(NOW.getTime() + 60_000),
      now: NOW,
    });
    await createHistoricalScanExecutionPort(prisma).run({
      organizationId: ORG,
      taskKey: fullTask,
      ownerRef: 'runtime-a',
      pagePort: pagePort([], 'FULL', REQUESTED_FROM),
      ingestPort,
    } as never);
    const full = await loadRecoveryScanById(prisma, { organizationId: ORG, scanId: fullScan.row.id });
    const fullSummary = buildScanSummaryView(full!);
    expect(fullSummary.coverage).toBe('FULL');
    expect(scanCoverageIsFull(fullSummary)).toBe(true);
    expect(fullSummary.disclaimerCodes).not.toContain('COVERAGE_NOT_FULL');
  });

  it('E · customs 全矩阵：四种 disposition + 三道 fail-closed 门', () => {
    const cases: ReadonlyArray<{
      label: string;
      input: unknown;
      outcome: string;
      reason?: string;
    }> = [
      { label: 'PERFECT → CLAIM_READY', input: record('E-1'), outcome: 'CLAIM_READY' },
      { label: 'NO_EVIDENCE → NEEDS_EVIDENCE', input: record('E-2', 'NO_EVIDENCE'), outcome: 'NEEDS_EVIDENCE' },
      { label: 'SPECIAL_PROVISION(9801) → NOT_CANDIDATE', input: record('E-3', 'SPECIAL_PROVISION'), outcome: 'NOT_CANDIDATE' },
      {
        label: '缺 historicalWindow → NEEDS_MANUAL_REVIEW/HISTORICAL_WINDOW_GATE_MISSING',
        input: { ...record('E-4'), historicalWindow: undefined },
        outcome: 'NEEDS_MANUAL_REVIEW',
        reason: 'HISTORICAL_WINDOW_GATE_MISSING',
      },
      {
        label: 'blocksClaimReady=true → NEEDS_MANUAL_REVIEW/HISTORICAL_WINDOW_BLOCKS_CLAIM_READY',
        input: { ...record('E-5'), historicalWindow: { blocksClaimReady: true, reasonCodes: ['COVERAGE_NOT_FULL'] } },
        outcome: 'NEEDS_MANUAL_REVIEW',
        reason: 'HISTORICAL_WINDOW_BLOCKS_CLAIM_READY',
      },
      {
        label: '缺 jurisdiction → NEEDS_MANUAL_REVIEW/MISSING_JURISDICTION',
        input: { ...record('E-6'), jurisdiction: null },
        outcome: 'NEEDS_MANUAL_REVIEW',
        reason: 'MISSING_JURISDICTION',
      },
    ];

    for (const matrixCase of cases) {
      const result = evaluateCustomsHistoricalCandidate(matrixCase.input as never);
      expect(result.outcome, matrixCase.label).toBe(matrixCase.outcome);
      if (matrixCase.reason !== undefined) expect(result.reasonCodes, matrixCase.label).toContain(matrixCase.reason);
      // 每格恒定的外部动作边界
      expect(result.filingPerformed, matrixCase.label).toBe(false);
      expect(result.paymentPerformed, matrixCase.label).toBe(false);
      expect(result.externalWritePerformed, matrixCase.label).toBe(false);
      expect(result.autoFilingAllowed, matrixCase.label).toBe(false);
    }

    // 批次汇总与单条一致
    const batch = evaluateCustomsHistoricalBatch(cases.map((entry) => entry.input) as never);
    expect(batch.summary.claimReady).toBe(1);
    expect(batch.summary.needsEvidence).toBe(1);
    expect(batch.summary.notCandidate).toBe(1);
    expect(batch.summary.needsManualReview).toBe(3);
  });

  it('F · tenant isolation E2E：跨租户任务一律 BLOCK，且不动他租户 durable 行', async () => {
    const window = resolveWindow(SOURCE_FROM);
    const a = await seedScan(ORG, window.effectiveFrom);
    // 两个租户的 Goal 必须真的不同（goalDigest/goalId 全局唯一）
    const b = await seedScan(ORG_B, window.effectiveFrom, 60, '检查我过去 4 年的关税损失，能追回的全部处理');

    const port = createHistoricalScanExecutionPort(prisma);
    // ORG_B 的 taskKey 在 ORG 的 runtime 上下文中执行 → BLOCK 且无 scanId
    const crossTenant = await port.run({
      organizationId: ORG,
      taskKey: b.taskKey,
      ownerRef: 'runtime-a',
      pagePort: pagePort([]),
      ingestPort,
    } as never);
    expect(crossTenant.blocked).toBe(true);
    expect(crossTenant.scanId).toBeNull();

    // 非扫描任务同样 fail-closed
    const nonScan = await port.run({
      organizationId: ORG,
      taskKey: 'task:recovery:CUSTOMS:opp-1',
      ownerRef: 'runtime-a',
      pagePort: pagePort([]),
      ingestPort,
    } as never);
    expect(nonScan.blocked).toBe(true);

    // 两个租户的 durable 行都未被跨租户尝试改动
    const rowA = await loadRecoveryScanById(prisma, { organizationId: ORG, scanId: a.created.row.id });
    const rowB = await loadRecoveryScanById(prisma, { organizationId: ORG_B, scanId: b.created.row.id });
    expect(rowA!.status).toBe('CREATED');
    expect(rowB!.status).toBe('CREATED');
    expect(rowA!.recordsScanned).toBe(0);
    expect(rowB!.recordsScanned).toBe(0);

    // 跨租户 scope 装载同样 BLOCK
    const crossScope = await loadScanScopeForClaimedTask(prisma, {
      organizationId: ORG_B,
      dedupeKey: a.created.row.dedupeKey,
    });
    expect(crossScope.ok).toBe(false);
  });

  it('G · 外部动作 / 第二事实源不变式：整条矩阵跑完后仍恒为 false', async () => {
    const window = resolveWindow(SOURCE_FROM);
    const { created, taskKey } = await seedScan(ORG, window.effectiveFrom);
    const rowsBefore = await prisma.recoveryScanRun.count();
    await claimRecoveryScanRun(prisma, {
      organizationId: ORG,
      scanId: created.row.id,
      leaseOwner: 'runtime-a',
      leaseExpiresAt: new Date(NOW.getTime() + 60_000),
      now: NOW,
    });
    await createHistoricalScanExecutionPort(prisma).run({
      organizationId: ORG,
      taskKey,
      ownerRef: 'runtime-a',
      pagePort: pagePort([]),
      ingestPort,
    } as never);

    const row = await loadRecoveryScanById(prisma, { organizationId: ORG, scanId: created.row.id });
    const summary = buildScanSummaryView(row!);
    expect(summary.filingPerformed).toBe(false);
    expect(summary.paymentPerformed).toBe(false);
    expect(summary.externalWritePerformed).toBe(false);
    expect(summary.claimsFiled).toBe(0);
    // 只改既有行：不新建行（无第二事实源）
    expect(await prisma.recoveryScanRun.count()).toBe(rowsBefore);
  });
});
