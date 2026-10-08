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
import { composeRsiRuntime } from '../runtime/rsi-run';
import type { RecoveryReadPorts } from '../services/intelligence/recovery-read-tools';
import { createHistoricalScanExecutionPort } from '../services/historical-scan/scan-execution-port';

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

// ---- AUDIT-2R3（MSG-20261008-07）定向夹具：PASS-only 执行 + verdictWatcher 走 wrapped controller ----
const SCAN_READ_PORTS: RecoveryReadPorts = {
  async opportunityRead(input) {
    return { opportunityRef: input.opportunityRef, status: 'READY', currency: 'USD', hasRecoverableAmount: true, hasRuleEvaluation: true };
  },
  async evidenceRead(input) {
    return { opportunityRef: input.opportunityRef, caseRef: 'case-1', evidenceCount: 1, kinds: ['ENTRY_RECORD'] };
  },
  async customsAuthorizationReadinessRead(input) {
    return { opportunityRef: input.opportunityRef, route: 'MODE_A', readyToFile: false, blockerCodes: ['POA_MISSING'] };
  },
};

function scanGuardDeps() {
  return {
    killSwitchResolver: {
      async resolve(scope: string) {
        return { scope, value: 'enabled', degraded: false, stale: false };
      },
    },
    audit: {
      async write() {
        /* no-op：审计由既有链路负责，测试不额外写库 */
      },
    },
  } as never;
}

async function seedScanFixture(organizationId: string, intent: string = INTENT) {
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
    effectiveFrom: REQUESTED_FROM,
    effectiveTo: REQUESTED_TO,
    requestedMonths: 60,
  });
  return { taskKey: 'task:recovery:CUSTOMS:' + created.row.dedupeKey, created };
}

/** domain step 调用计数 + 走既有 execution port（durable scope → runHistoricalBackfill）。 */
function scanStepSpy() {
  const calls: Array<{ ok: boolean; scanId: string | null; status: string }> = [];
  const step = async ({ dedupeKey }: { dedupeKey: string }) => {
    const executed = await createHistoricalScanExecutionPort(prisma).run({
      organizationId: ORG,
      taskKey: dedupeKey,
      pagePort: {
        async fetchPage({ shard }) {
          return {
            records: [syntheticCustomsRecord('ENTRY-W-' + shard.key, 'PERFECT')],
            nextCursor: null,
            coverageFrom: '2025-10-08',
            coverageTo: REQUESTED_TO,
            coverageStatus: 'SOURCE_LIMITED',
          };
        },
      },
      ingestPort: {
        async ingest({ records }) {
          const batch = evaluateCustomsHistoricalBatch(records as never);
          return { accepted: batch.summary.scanned, rejected: 0, eligibleFound: batch.summary.claimReady };
        },
      },
    });
    calls.push({ ok: executed.ok, scanId: executed.scanId, status: executed.status });
    return executed;
  };
  return { calls, step };
}

async function composeScanRuntime(input: {
  taskKey: string;
  verdictArtifact: string;
  onDomainStep: (args: { dedupeKey: string }) => Promise<unknown>;
  extraTaskKeys?: readonly string[];
}) {
  const queue = [input.taskKey, ...(input.extraTaskKeys ?? [])].map((dedupeKey, index) => ({
    id: 'task-scan-' + (index + 1),
    dedupeKey,
    priority: 'P2',
  }));
  return composeRsiRuntime({
    readFile: async (path: string) => {
      if (path === 'mem://tasks') return JSON.stringify(queue);
      if (path === 'mem://verdict') return input.verdictArtifact;
      return '[]';
    },
    tasksPath: 'mem://tasks',
    verdictPath: 'mem://verdict',
    verdictWatch: { intervalMs: 10_000 },
    historicalScanDomainStep: (claimed) => input.onDomainStep(claimed),
    productRecoveryPack: {
      appActionGuardDeps: scanGuardDeps(),
      readPorts: SCAN_READ_PORTS,
      bind: (task: { id: string; dedupeKey: string; priority: string }) => {
        const match = /^task:recovery:([A-Z_]+):(.+)$/.exec(task.dedupeKey);
        if (match === null) return null;
        return {
          organizationId: ORG,
          domain: 'CUSTOMS' as never,
          actionKind: 'EXECUTE_READ_ONLY_CHECK' as never,
          opportunityRef: match[2]!,
        };
      },
      scanScope: {
        async load(ref: { organizationId: string; dedupeKey: string }) {
          const loaded = await loadScanScopeForClaimedTask(prisma, {
            organizationId: ref.organizationId,
            dedupeKey: ref.dedupeKey,
          });
          return { ok: loaded.ok, reasonCodes: loaded.reasonCodes };
        },
      },
    },
    awaitVerdict: false,
  });
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
  it('runtime leg：既有 ONE SI Runtime composition（productRecoveryPack）认领该 scan task，并由 runtime 自行装载 durable scope', async () => {
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

    // planner 生成的 task identity：task:recovery:<DOMAIN>:<suffix>（suffix 含 durable scan token）
    const taskKey = 'task:recovery:CUSTOMS:' + created.row.dedupeKey;
    const loadedRefs: string[] = [];
    const readPorts: RecoveryReadPorts = {
      async opportunityRead(input) {
        return { opportunityRef: input.opportunityRef, status: 'READY', currency: 'USD', hasRecoverableAmount: true, hasRuleEvaluation: true };
      },
      async evidenceRead(input) {
        return { opportunityRef: input.opportunityRef, caseRef: 'case-1', evidenceCount: 1, kinds: ['ENTRY_RECORD'] };
      },
      async customsAuthorizationReadinessRead(input) {
        return { opportunityRef: input.opportunityRef, route: 'MODE_A', readyToFile: false, blockerCodes: ['POA_MISSING'] };
      },
    };
    const appGuardDeps = () =>
      ({
        killSwitchResolver: {
          async resolve(scope: string) {
            return { scope, value: 'enabled', degraded: false, stale: false };
          },
        },
        audit: { async write() { /* no-op（本用例不校验审计落盘） */ } },
      }) as never;

    // AUDIT-2R：runtime 认领之后，由 server-owned composition 显式驱动 historical scan execution port
    const executionPort = createHistoricalScanExecutionPort(prisma);
    const domainStepOutcomes: Array<{ ok: boolean; scanId: string | null; status: string }> = [];
    const composition = await composeRsiRuntime({
      readFile: async (path: string) =>
        path === 'mem://tasks' ? JSON.stringify([{ id: 'task-scan-1', dedupeKey: taskKey, priority: 'P2' }]) : '[]',
      tasksPath: 'mem://tasks',
      historicalScanDomainStep: async ({ dedupeKey }) => {
        const executed = await executionPort.run({
          organizationId: ORG,
          taskKey: dedupeKey,
          pagePort: {
            async fetchPage({ shard }) {
              return {
                records: [syntheticCustomsRecord('ENTRY-D-' + shard.key, 'PERFECT')],
                nextCursor: null,
                coverageFrom: '2025-10-08',
                coverageTo: REQUESTED_TO,
                coverageStatus: 'SOURCE_LIMITED',
              };
            },
          },
          ingestPort: {
            async ingest({ records }: { records: readonly unknown[] }) {
              const batch = evaluateCustomsHistoricalBatch(records as never);
              return { accepted: batch.summary.scanned, rejected: 0, eligibleFound: batch.summary.claimReady };
            },
          },
        });
        domainStepOutcomes.push({ ok: executed.ok, scanId: executed.scanId, status: executed.status });
        return executed;
      },
      productRecoveryPack: {
        appActionGuardDeps: appGuardDeps(),
        readPorts,
        bind: (task: { id: string; dedupeKey: string; priority: string }) => {
          const match = /^task:recovery:([A-Z_]+):(.+)$/.exec(task.dedupeKey);
          if (match === null) return null;
          return { organizationId: ORG, domain: 'CUSTOMS' as never, actionKind: 'EXECUTE_READ_ONLY_CHECK' as never, opportunityRef: match[2]! };
        },
        scanScope: {
          async load(ref: { organizationId: string; dedupeKey: string }) {
            loadedRefs.push(ref.dedupeKey);
            const loaded = await loadScanScopeForClaimedTask(prisma, {
              organizationId: ref.organizationId,
              dedupeKey: ref.dedupeKey,
            });
            return { ok: loaded.ok, reasonCodes: loaded.reasonCodes };
          },
        },
      },
      awaitVerdict: false,
    });

    const outcome = await composition.controller.tick();
    // ① 任务由**唯一 runtime**（productRecoveryPack）认领
    expect(outcome.claimed?.dedupeKey).toBe(taskKey);
    // ② runtime 自行经扫描范围端口装载 durable scope（不是测试直接查库）
    expect(loadedRefs).toEqual([taskKey]);
    expect(composition.domainDispatchLog().length).toBeGreaterThan(0);
    // ③ 同一次 tick 内，server-owned composition 继续驱动该 scan 的 durable backfill（单条连续链）
    //    AUDIT-2R2 CHANGE 2：存在 domain pack 时 runtime 强制 park-for-judge ——
    //    claim 之后任务停在等待裁决，**不得**在裁决收口前完成 scan。
    expect(composition.controller.state().waitingForVerdict).toBe(true);
    expect(domainStepOutcomes).toHaveLength(0);

    // ④ 裁决收口（JUDGE_VERDICT_RECEIVED）后的续跑路径才驱动 domain step（恰好一次）
    composition.controller.markWaitingForVerdict('PASS');
    await composition.controller.emit('JUDGE_VERDICT_RECEIVED');
    expect(domainStepOutcomes).toHaveLength(1);
    expect(domainStepOutcomes[0]!.scanId).toBe(created.row.id);
    expect(domainStepOutcomes[0]!.status).toBe('COMPLETED');
    expect(domainStepOutcomes[0]!.ok).toBe(true);

    // ⑤ 执行端口本身仍可用（负向：非扫描任务 key / 跨租户 → BLOCK）
    const notScanTask = await executionPort.run({
      organizationId: ORG,
      taskKey: 'task:recovery:CUSTOMS:opp-1',
      pagePort: { async fetchPage() { return { records: [], nextCursor: null }; } },
      ingestPort: { async ingest() { return { accepted: 0, rejected: 0 }; } },
    });
    expect(notScanTask.blocked).toBe(true);
    const crossTenant = await executionPort.run({
      organizationId: ORG_B,
      taskKey,
      pagePort: { async fetchPage() { return { records: [], nextCursor: null }; } },
      ingestPort: { async ingest() { return { accepted: 0, rejected: 0 }; } },
    });
    expect(crossTenant.blocked).toBe(true);
    expect(crossTenant.scanId).toBeNull();
  });

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

  // ---------------- AUDIT-2R3（MSG-20261008-07）：PASS-only 执行 + verdictWatcher 走 wrapped controller ----------------

  it('AUDIT-2R3 CHANGE B：真实 verdictWatcher（PASS artifact）→ wrapped controller → domain step 恰好一次 + scan COMPLETED', async () => {
    const { taskKey, created } = await seedScanFixture(ORG);
    const spy = scanStepSpy();
    const composition = await composeScanRuntime({
      taskKey,
      verdictArtifact: JSON.stringify({ messageId: 'msg-pass-1', verdict: 'PASS' }),
      onDomainStep: spy.step,
    });

    // claim + park-for-judge：裁决前零执行
    await composition.controller.tick();
    expect(composition.controller.state().waitingForVerdict).toBe(true);
    expect(spy.calls).toHaveLength(0);

    // **生产路径**：verdictWatcher 读 artifact → 写 verdict → emit（必须走 wrapped controller）
    const polled = await composition.verdictWatcher!.pollOnce();
    expect(polled.delivered).toBe(true);
    expect(composition.verdictWatcher!.deliveries()).toBe(1);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.scanId).toBe(created.row.id);
    expect(spy.calls[0]!.status).toBe('COMPLETED');
    expect(spy.calls[0]!.ok).toBe(true);

    const row = await loadRecoveryScanById(prisma, { organizationId: ORG, scanId: created.row.id });
    expect(row!.status).toBe('COMPLETED');
    expect(row!.recordsScanned).toBeGreaterThan(0);
  });

  it('AUDIT-2R3 CHANGE A：BLOCK verdict → domain step 0 且 durable scan 未推进', async () => {
    const { taskKey, created } = await seedScanFixture(ORG);
    const spy = scanStepSpy();
    const composition = await composeScanRuntime({
      taskKey,
      verdictArtifact: JSON.stringify({ messageId: 'msg-block-1', verdict: 'BLOCK' }),
      onDomainStep: spy.step,
    });

    await composition.controller.tick();
    const polled = await composition.verdictWatcher!.pollOnce();
    expect(polled.delivered).toBe(true);

    // BLOCK：绝不回填（旧实现只看 !waitingForVerdict 会误放行）
    expect(spy.calls).toHaveLength(0);
    const row = await loadRecoveryScanById(prisma, { organizationId: ORG, scanId: created.row.id });
    // 执行端口根本没被调用 ⇒ durable scan 仍停留在创建态，未被认领 / 未推进检查点
    expect(row!.status).toBe('CREATED');
    expect(row!.recordsScanned).toBe(0);
    expect(row!.nextShardIndex).toBe(0);
  });

  it('AUDIT-2R3 CHANGE A：REVISE verdict → domain step 0 且 durable scan 未推进', async () => {
    const { taskKey, created } = await seedScanFixture(ORG);
    const spy = scanStepSpy();
    const composition = await composeScanRuntime({
      taskKey,
      verdictArtifact: JSON.stringify({ messageId: 'msg-revise-1', verdict: 'REVISE' }),
      onDomainStep: spy.step,
    });

    await composition.controller.tick();
    const polled = await composition.verdictWatcher!.pollOnce();
    expect(polled.delivered).toBe(true);

    expect(spy.calls).toHaveLength(0);
    const row = await loadRecoveryScanById(prisma, { organizationId: ORG, scanId: created.row.id });
    expect(row!.status).toBe('CREATED');
    expect(row!.recordsScanned).toBe(0);
  });

  it('AUDIT-2R3 CHANGE A：watchdog 收口 PASS verdict（无 artifact 事件）→ domain step 恰好一次', async () => {
    const { taskKey, created } = await seedScanFixture(ORG);
    const spy = scanStepSpy();
    const composition = await composeScanRuntime({
      taskKey,
      verdictArtifact: '{}',
      onDomainStep: spy.step,
    });

    await composition.controller.tick();
    expect(spy.calls).toHaveLength(0);

    // 真实 Judge verdict 写入 + watchdog tick 收口（同一条收口语义，不依赖 tick 之外的旁路）
    composition.controller.markWaitingForVerdict('PASS');
    await composition.controller.tick();
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.scanId).toBe(created.row.id);
    expect(spy.calls[0]!.status).toBe('COMPLETED');
  });

  it('AUDIT-2R3：重复 PASS verdict / 重复 poll / 额外 tick → 不重复回填（幂等）', async () => {
    const { taskKey, created } = await seedScanFixture(ORG);
    const spy = scanStepSpy();
    const composition = await composeScanRuntime({
      taskKey,
      verdictArtifact: JSON.stringify({ messageId: 'msg-pass-2', verdict: 'PASS' }),
      onDomainStep: spy.step,
    });

    await composition.controller.tick();
    await composition.verdictWatcher!.pollOnce();
    expect(spy.calls).toHaveLength(1);

    // 同 messageId+verdict 已被 watcher 去重 → 不再投递
    const again = await composition.verdictWatcher!.pollOnce();
    expect(again.delivered).toBe(false);
    expect(spy.calls).toHaveLength(1);

    // 重复 PASS 裁决 / 额外 watchdog tick → 仍只有一次回填，且 durable scan 保持 COMPLETED
    composition.controller.markWaitingForVerdict('PASS');
    await composition.controller.emit('JUDGE_VERDICT_RECEIVED');
    await composition.controller.tick();
    expect(spy.calls).toHaveLength(1);
    const row = await loadRecoveryScanById(prisma, { organizationId: ORG, scanId: created.row.id });
    expect(row!.status).toBe('COMPLETED');
  });

  it('AUDIT-2R4：REVISE 后 stale pending 必须清除 —— 后续任务 PASS 不得执行被 REVISE 的原 scan', async () => {
    const { taskKey, created } = await seedScanFixture(ORG);
    const spy = scanStepSpy();
    const composition = await composeScanRuntime({
      taskKey,
      verdictArtifact: JSON.stringify({ messageId: 'msg-revise-stale', verdict: 'REVISE' }),
      onDomainStep: spy.step,
    });

    // ① 认领 scan task → park
    await composition.controller.tick();
    expect(composition.controller.state().waitingForVerdict).toBe(true);
    // ② REVISE 收口：当下零执行
    const polled = await composition.verdictWatcher!.pollOnce();
    expect(polled.delivered).toBe(true);
    expect(spy.calls).toHaveLength(0);
    // ③ engine 已插入 P0 revision task 并认领；随后该 revision task 拿到 PASS
    composition.controller.markWaitingForVerdict('PASS');
    await composition.controller.emit('JUDGE_VERDICT_RECEIVED');
    await composition.controller.tick();
    // 关键：原 scan 被判 REVISE，绝不能借后续任务的 PASS 被执行
    expect(spy.calls).toHaveLength(0);
    const row = await loadRecoveryScanById(prisma, { organizationId: ORG, scanId: created.row.id });
    expect(row!.status).toBe('CREATED');
    expect(row!.recordsScanned).toBe(0);
  });

  it('AUDIT-2R4：多个 scan 任务排队 → PASS 只执行当前 armed scan，不误执行下一个', async () => {
    const first = await seedScanFixture(ORG);
    // 第二个 Goal 必须真的不同（goalDigest / scan dedupeKey 都不同）→ 用不同回溯年限
    const second = await seedScanFixture(ORG, '检查我过去 4 年的关税损失，能追回的全部处理');
    expect(second.taskKey).not.toBe(first.taskKey);
    const spy = scanStepSpy();
    const composition = await composeScanRuntime({
      taskKey: first.taskKey,
      extraTaskKeys: [second.taskKey],
      verdictArtifact: JSON.stringify({ messageId: 'msg-pass-armed', verdict: 'PASS' }),
      onDomainStep: spy.step,
    });

    // 认领 A（arm A）→ park
    await composition.controller.tick();
    expect(composition.controller.state().waitingForVerdict).toBe(true);
    // PASS 收口：同一次调用里 engine 完成 A 并立刻认领 B（arm B）——不得误执行 B
    composition.controller.markWaitingForVerdict('PASS');
    await composition.controller.emit('JUDGE_VERDICT_RECEIVED');
    // 只应执行 A
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.scanId).toBe(first.created.row.id);
    const secondRow = await loadRecoveryScanById(prisma, { organizationId: ORG, scanId: second.created.row.id });
    expect(secondRow!.status).toBe('CREATED');

    // B 拿到自己的 PASS → 执行 B
    composition.controller.markWaitingForVerdict('PASS');
    await composition.controller.emit('JUDGE_VERDICT_RECEIVED');
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls[1]!.scanId).toBe(second.created.row.id);
  });
});
