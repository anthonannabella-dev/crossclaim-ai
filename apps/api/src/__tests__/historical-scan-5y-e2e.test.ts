// HISTORICAL_RECOVERY_SCAN_V1 / PHASE 10 —— 合成 5 年 E2E（真实 PostgreSQL + 真实模块链）
// ---------------------------------------------------------------------------
// 链路：Goal 文本 → 确定性编译（60 个月）→ server 校验 → 计划 →
//       durable RecoveryScanRun（PHASE 2）→ Runtime 侧 scope 装载（PHASE 3）→
//       窗口解析（PHASE 4）→ 分片回填 + 检查点（PHASE 6）→ Customs 历史管线（PHASE 8）→
//       customer-safe summary（PHASE 9）。
// 说明：分片数据源是 **synthetic 端口**（仅 test/acceptance 使用），不是 production adapter；
//       它只喂"原始记录"，所有判定仍走既有 server-owned 链。

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { compileAgentGoal } from '../services/agent-goal/goal-compiler';
import { validateAgentGoalDraft } from '../services/agent-goal/goal-validator';
// 说明：queue admission 腿（plan → 既有队列 → ONE SI Runtime claim）由既有 GA-* 与
// historical-scan-runtime-scope 套件覆盖；本 E2E 聚焦 5 年链路的 scan/backfill/customs/summary。
import {
  buildScanSummaryView,
  claimRecoveryScanRun,
  createOrGetRecoveryScan,
  loadRecoveryScanById,
  loadScanScopeForClaimedTask,
  resolveRecoveryWindow,
  runHistoricalBackfill,
  scanCoverageIsFull,
  type BackfillPagePort,
} from '../services/historical-scan';
import { evaluateCustomsHistoricalBatch } from '../services/historical-scan/customs-historical-pipeline';

const prisma = new PrismaClient();

const ORG = 'c0ffee00-0000-4000-8000-00000000005a';
const ORG_B = 'c0ffee00-0000-4000-8000-00000000005b';
const USER = 'c0ffee00-0000-4000-8000-0000000000f5';
const INTENT = '检查我过去 5 年的关税损失，能追回的全部处理';
const NOW = new Date('2026-10-08T00:00:00.000Z');
const REQUESTED_FROM = '2021-10-08';
const REQUESTED_TO = '2026-10-08';

const COMPLETE_CHAIN = { chainStatus: 'COMPLETE', missing: [], partial: [], lowConfidence: [] } as never;
const EXACT_MATCH = { status: 'EXACT' } as never;
const VERIFIED_POLICY = {
  policyId: 'us-drawback-v1',
  policyVersion: '1.0.0',
  anchorField: 'exportDate' as const,
  daysFromAnchor: 1825,
  verification: 'LEGAL_VERIFIED' as const,
};

function syntheticCustomsRecord(entryNumber: string, kind: 'PERFECT' | 'NO_EVIDENCE' | 'SPECIAL_PROVISION') {
  return {
    entryNumber,
    scope: { organizationId: ORG, platformAccountId: 'acct-scan-1' },
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
  };
}

async function truncate(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "RecoveryScanRun", "AgentGoalRun", "AgentGoal", "AuditLog", "Membership", "User", "Organization" CASCADE;',
  );
}

beforeAll(async () => {
  await truncate();
  await prisma.organization.create({ data: { id: ORG, name: 'scan-5y', slug: 'scan-5y' } });
  await prisma.organization.create({ data: { id: ORG_B, name: 'scan-5y-b', slug: 'scan-5y-b' } });
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE "RecoveryScanRun" CASCADE;');
  await prisma.agentGoal.deleteMany({});
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('PHASE 10 · 合成 5 年 E2E（Goal → scan → shard → customs → CLAIM_READY → summary）', () => {
  it('完整链路跑通：60 个月 → durable scan → scope 装载 → 分片回填 → 四态结果 → 覆盖诚实 summary', async () => {
    // ① Goal 文本 → 确定性编译（5 年 = 60 个月）
    const compiled = compileAgentGoal({ text: INTENT });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.draft.timeRange).toEqual({ kind: 'LAST_N_MONTHS', months: 60 });
    expect(compiled.modelCallCount).toBe(0);

    // ② server 校验 + 计划（既有 Goal 链，未新建执行路径）
    const validated = validateAgentGoalDraft({
      draft: compiled.draft,
      context: { organizationId: ORG, actorUserId: USER, now: NOW },
    });
    expect(validated.timeRange).toEqual({ kind: 'LAST_N_MONTHS', months: 60 });

    await prisma.agentGoal.create({
      data: {
        id: validated.goalId,
        organizationId: ORG,
        createdBy: USER,
        rawUserIntent: INTENT,
        normalizedGoal: { version: validated.version, goalDigest: validated.goalDigest, timeRange: validated.timeRange },
        status: 'ADMITTED',
        createdAt: NOW,
        updatedAt: NOW,
      },
    });

    // ③ PHASE 4 窗口解析：数据源只覆盖最近 1 年 → effective 收窄、SOURCE_LIMITED（不得声称 5 年 FULL）
    const window = resolveRecoveryWindow({
      domain: 'CUSTOMS',
      requestedFrom: REQUESTED_FROM,
      requestedTo: REQUESTED_TO,
      jurisdiction: 'US',
      sourceCoverageFrom: '2025-10-08',
      sourceCoverageTo: REQUESTED_TO,
      policyWindow: {
        anchorField: 'exportDate',
        daysFromAnchor: 1825,
        verified: true,
        anchorDate: '2025-06-01',
      },
    });
    expect(window.coverage).toBe('SOURCE_LIMITED');
    expect(window.effectiveFrom).toBe('2025-10-08');
    expect(window.blocksClaimReady).toBe(false);

    // ④ PHASE 2 durable scan（requested 保留 5 年，effective 用解析结果）
    const created = await createOrGetRecoveryScan(prisma, {
      organizationId: ORG,
      goalId: validated.goalId,
      goalDigest: validated.goalDigest,
      domain: 'CUSTOMS',
      provider: 'CBP',
      platformAccountId: null,
      requestedFrom: REQUESTED_FROM,
      requestedTo: REQUESTED_TO,
      effectiveFrom: window.effectiveFrom,
      effectiveTo: window.effectiveTo,
      requestedMonths: 60,
      reasonCodes: window.reasonCodes,
    });
    expect(created.created).toBe(true);

    // ⑤ PHASE 3：Runtime 侧按 dedupeKey 重新装载 scope（caller 自报範囲被忽略）
    const claimed = await claimRecoveryScanRun(prisma, {
      organizationId: ORG,
      scanId: created.row.id,
      leaseOwner: 'worker-1',
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    expect(claimed?.status).toBe('RUNNING');
    const loaded = await loadScanScopeForClaimedTask(prisma, {
      organizationId: ORG,
      dedupeKey: created.row.dedupeKey,
      assertedRange: { from: '1990-01-01', to: '2030-01-01', months: 999 },
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.scope.requestedMonths).toBe(60);
    expect(loaded.scope.effectiveFrom).toBe(window.effectiveFrom);
    expect(loaded.scope.callerRangeTrusted).toBe(false);

    // 跨租户装载 → BLOCK
    const crossTenant = await loadScanScopeForClaimedTask(prisma, {
      organizationId: ORG_B,
      dedupeKey: created.row.dedupeKey,
    });
    expect(crossTenant.ok).toBe(false);

    // ⑥ PHASE 6 分片回填 + PHASE 8 customs 管线（synthetic 源只喂原始记录）
    const fetchCalls: string[] = [];
    const pagePort: BackfillPagePort = {
      async fetchPage({ shard }) {
        fetchCalls.push(shard.key);
        return {
          records: [
            syntheticCustomsRecord('ENTRY-A-' + shard.key, 'PERFECT'),
            syntheticCustomsRecord('ENTRY-B-' + shard.key, 'NO_EVIDENCE'),
            syntheticCustomsRecord('ENTRY-C-' + shard.key, 'SPECIAL_PROVISION'),
          ],
          nextCursor: null,
          coverageFrom: '2025-10-08',
          coverageTo: REQUESTED_TO,
          coverageStatus: 'SOURCE_LIMITED',
        };
      },
    };
    const ingestPort = {
      async ingest({ records }: { records: readonly unknown[] }) {
        const batch = evaluateCustomsHistoricalBatch(records as never);
        return {
          accepted: batch.summary.scanned,
          rejected: 0,
          opportunitiesFound: batch.summary.opportunitiesSurfaced,
          eligibleFound: batch.summary.claimReady,
          needsEvidenceFound: batch.summary.needsEvidence,
          expiredFound: batch.summary.expired,
        };
      },
    };

    // ⑥a 预算中断 → PARTIAL 且检查点落库
    const first = await runHistoricalBackfill(prisma, {
      organizationId: ORG,
      scanId: created.row.id,
      pagePort,
      ingestPort,
      maxPages: 3,
    });
    expect(first.status).toBe('PARTIAL');
    const processedAfterFirst = fetchCalls.length;
    expect(processedAfterFirst).toBe(3);

    // ⑥b 续跑：从检查点续到完成，且没有任何分片被重复处理
    const resumed = await runHistoricalBackfill(prisma, {
      organizationId: ORG,
      scanId: created.row.id,
      pagePort,
      ingestPort,
    });
    expect(resumed.status).toBe('COMPLETED');
    expect(new Set(fetchCalls).size).toBe(fetchCalls.length);

    // ⑦ PHASE 9 customer-safe summary（覆盖诚实 + 零外部动作）
    const row = await loadRecoveryScanById(prisma, { organizationId: ORG, scanId: created.row.id });
    expect(row).not.toBeNull();
    const summary = buildScanSummaryView(row!);
    expect(summary.requestedMonths).toBe(60);
    expect(summary.requestedFrom).toBe(REQUESTED_FROM);
    expect(summary.coverage).toBe('SOURCE_LIMITED');
    expect(scanCoverageIsFull(summary)).toBe(false);
    expect(summary.disclaimerCodes).toContain('COVERAGE_NOT_FULL');
    expect(summary.recordsScanned).toBeGreaterThan(0);
    expect(summary.eligibleFound).toBeGreaterThan(0);
    expect(summary.needsEvidenceFound).toBeGreaterThan(0);
    expect(summary.claimsFiled).toBe(0);
    expect(summary.filingPerformed).toBe(false);
    expect(summary.externalWritePerformed).toBe(false);
    expect(summary.paymentPerformed).toBe(false);
  });
});
