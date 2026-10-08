// HISTORICAL_RECOVERY_SCAN_V1 / PHASE 11 —— Runtime / Guard / Policy / 租户 / 外写 边界验证
// ---------------------------------------------------------------------------
// 目标（全部为「不可越界」的**负向**证据）：
//   ① 静态：历史扫描服务目录内**没有**第二 runtime / 第二调度器 / 第二队列 / 外部网络 / 外部写；
//   ② 组合层：缺 durable scanScope 的扫描任务 fail-closed；domainPacks 不能冒充 recovery-si 绕过共享 guard；
//   ③ 租户：跨租户 scope 一律 BLOCK，且不得修改对方租户的 durable scan；
//   ④ 外写：执行端口只写 scan scope / checkpoint（行数不变），summary 的 filing / payment / externalWrite 恒为 false。
// 说明：本 PHASE 只做边界与负向验证，不新增执行路径、不引入第二 runtime。

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createRecoverySiPack, RECOVERY_SI_PACK_BOUNDARY } from '../runtime/recovery-si-pack';
import { RECOVERY_SI_PRODUCT_COMPOSITION_BOUNDARY } from '../runtime/recovery-si-product-composition';
import { RECOVERY_GUARD_ADAPTER_BOUNDARY } from '../runtime/recovery-guard-adapter';
import { RSI_RUNTIME_COMPOSITION_BOUNDARY, composeRsiRuntime } from '../runtime/rsi-run';
import { RSI_CONTROLLER_CONTINUATION_BOUNDARY } from '../runtime/rsi-controller-continuation';
import { HISTORICAL_SCAN_EXECUTION_PORT_BOUNDARY, createHistoricalScanExecutionPort } from '../services/historical-scan/scan-execution-port';
import { CUSTOMS_HISTORICAL_PIPELINE_BOUNDARY, evaluateCustomsHistoricalBatch } from '../services/historical-scan/customs-historical-pipeline';
import {
  buildScanSummaryView,
  createOrGetRecoveryScan,
  loadRecoveryScanById,
  loadScanScopeForClaimedTask,
} from '../services/historical-scan';
import { compileAgentGoal } from '../services/agent-goal/goal-compiler';
import { validateAgentGoalDraft } from '../services/agent-goal/goal-validator';
import type { RecoveryReadPorts } from '../services/intelligence/recovery-read-tools';

const API_ROOT = join(__dirname, '..', '..');
const SCAN_SERVICE_DIR = join(API_ROOT, 'src', 'services', 'historical-scan');

const prisma = new PrismaClient();

const ORG = 'c0ffee00-0000-4000-8000-00000000006a';
const ORG_B = 'c0ffee00-0000-4000-8000-00000000006b';
const USER = 'c0ffee00-0000-4000-8000-0000000000f6';
const INTENT = '检查我过去 5 年的关税损失，能追回的全部处理';
const NOW = new Date('2026-10-08T00:00:00.000Z');
const REQUESTED_FROM = '2021-10-08';
const REQUESTED_TO = '2026-10-08';

const READ_PORTS: RecoveryReadPorts = {
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

const SCAN_TASK_KEY = 'task:recovery:CUSTOMS:scan:v1:phase11';

const BIND = () =>
  ({
    organizationId: ORG,
    domain: 'CUSTOMS' as never,
    actionKind: 'EXECUTE_READ_ONLY_CHECK' as never,
    opportunityRef: 'opp-phase11',
  });

const COMPLETE_CHAIN = { chainStatus: 'COMPLETE', missing: [], partial: [], lowConfidence: [] } as never;

function syntheticRecord(entryNumber: string) {
  return {
    entryNumber,
    scope: { organizationId: ORG, platformAccountId: 'acct-phase11' },
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

async function seedScan(organizationId: string) {
  const compiled = compileAgentGoal({ text: INTENT });
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
      rawUserIntent: INTENT,
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

beforeAll(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "RecoveryScanRun", "AgentGoalRun", "AgentGoal", "AuditLog", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: 'phase11', slug: 'phase11' } });
  await prisma.organization.create({ data: { id: ORG_B, name: 'phase11-b', slug: 'phase11-b' } });
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE "RecoveryScanRun" CASCADE;');
  await prisma.agentGoal.deleteMany({});
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('PHASE 11 · 静态边界（SECOND_* = 0 / 无外部网络与外写）', () => {
  it('边界常量：无第二 runtime/scheduler/guard/policy，且凭据与外写恒为 false', () => {
    // Runtime composition
    expect(RSI_RUNTIME_COMPOSITION_BOUNDARY.secondRuntime).toBe(0);
    expect(RSI_RUNTIME_COMPOSITION_BOUNDARY.performsExternalWrite).toBe(false);
    expect(RSI_RUNTIME_COMPOSITION_BOUNDARY.writesDatabase).toBe(false);
    expect(RSI_RUNTIME_COMPOSITION_BOUNDARY.readsCredentials).toBe(false);
    // PHASE 10 收口语义仍在
    expect(RSI_RUNTIME_COMPOSITION_BOUNDARY.historicalScanDomainStepRequiresPassVerdict).toBe(true);
    expect(RSI_RUNTIME_COMPOSITION_BOUNDARY.verdictWatcherUsesDomainStepController).toBe(true);
    expect(String(RSI_RUNTIME_COMPOSITION_BOUNDARY.historicalScanPendingBinding)).toContain('ARMED');
    // 既有 ONE SI Runtime 组件边界
    expect(RSI_CONTROLLER_CONTINUATION_BOUNDARY.holdsProviderCredentials).toBe(false);
    expect(RSI_CONTROLLER_CONTINUATION_BOUNDARY.writesDatabase).toBe(false);
    expect(RSI_CONTROLLER_CONTINUATION_BOUNDARY.proposalIsNotVerdict).toBe(true);
    expect(RSI_CONTROLLER_CONTINUATION_BOUNDARY.runnerCannotWriteVerdict).toBe(true);
    expect(RSI_CONTROLLER_CONTINUATION_BOUNDARY.parkForJudgeSupported).toBe(true);
    // Recovery pack / 产品组装 / guard adapter：只读、无第二 guard / policy
    expect(RECOVERY_SI_PACK_BOUNDARY.isSecondRuntime).toBe(false);
    expect(RECOVERY_SI_PACK_BOUNDARY.executesActions).toBe(false);
    expect(RECOVERY_SI_PACK_BOUNDARY.writesDatabase).toBe(false);
    expect(RECOVERY_SI_PACK_BOUNDARY.networkCalls).toBe(0);
    expect(RECOVERY_SI_PACK_BOUNDARY.realModelCalls).toBe(0);
    expect(RECOVERY_SI_PRODUCT_COMPOSITION_BOUNDARY.secondGuardImplementation).toBe('FORBIDDEN');
    expect(RECOVERY_GUARD_ADAPTER_BOUNDARY.secondGuardImplementation).toBe('FORBIDDEN');
    expect(RECOVERY_GUARD_ADAPTER_BOUNDARY.reusesSharedGuard).toContain('createAppActionGuard');
    expect(RECOVERY_GUARD_ADAPTER_BOUNDARY.onUnavailable).toContain('DENY');
    // 历史扫描执行端口：在既有 runtime 内，范围只来自 durable scan，无外部写
    expect(HISTORICAL_SCAN_EXECUTION_PORT_BOUNDARY.secondRuntime).toBe(false);
    expect(HISTORICAL_SCAN_EXECUTION_PORT_BOUNDARY.secondScheduler).toBe(false);
    expect(HISTORICAL_SCAN_EXECUTION_PORT_BOUNDARY.insideExistingOneSiRuntime).toBe(true);
    expect(HISTORICAL_SCAN_EXECUTION_PORT_BOUNDARY.scopeFromDurableScanOnly).toBe(true);
    expect(HISTORICAL_SCAN_EXECUTION_PORT_BOUNDARY.externalWritePerformed).toBe(false);
    // Customs 历史管线：复用既有链，不申报/不付款/不建第二事实源
    expect(CUSTOMS_HISTORICAL_PIPELINE_BOUNDARY.reusesExistingChain).toBe(true);
    expect(CUSTOMS_HISTORICAL_PIPELINE_BOUNDARY.secondCustomsTruth).toBe(false);
    expect(CUSTOMS_HISTORICAL_PIPELINE_BOUNDARY.autoFilingAllowed).toBe(false);
    expect(CUSTOMS_HISTORICAL_PIPELINE_BOUNDARY.filingPerformed).toBe(false);
    expect(CUSTOMS_HISTORICAL_PIPELINE_BOUNDARY.paymentPerformed).toBe(false);
    expect(CUSTOMS_HISTORICAL_PIPELINE_BOUNDARY.maxDisposition).toBe('CLAIM_READY');
  });

  it('历史扫描服务目录源码：无第二调度器 / runtime / 队列 / 外部网络 / 外部写', () => {
    const sources = readdirSync(SCAN_SERVICE_DIR)
      .filter((file) => file.endsWith('.ts'))
      .map((file) => ({ file, text: readFileSync(join(SCAN_SERVICE_DIR, file), 'utf8') }));
    expect(sources.length).toBeGreaterThan(5);

    const forbidden: ReadonlyArray<{ label: string; re: RegExp }> = [
      { label: '第二调度器 setInterval/setTimeout', re: /\bsetInterval\s*\(|\bsetTimeout\s*\(/ },
      { label: '第二 runtime Worker/child_process', re: /\bnew\s+Worker\s*\(|child_process/ },
      { label: '第二队列 bullmq/agenda/pg-boss/node-cron', re: /bullmq|BullMQ|agenda|pg-boss|node-cron|new\s+Queue\s*\(/ },
      { label: '外部网络 fetch/axios/http.request/undici', re: /\bfetch\s*\(|axios|node:https?\b|undici/ },
      { label: '外部写 writeFile/createWriteStream', re: /\bwriteFile\b|createWriteStream/ },
    ];
    const hits: string[] = [];
    for (const { file, text } of sources) {
      for (const { label, re } of forbidden) {
        if (re.test(text)) hits.push(file + ' → ' + label);
      }
    }
    expect(hits).toEqual([]);
  });
});

describe('PHASE 11 · Guard / Policy 边界（fail-closed，不可绕过）', () => {
  it('扫描任务缺 durable scanScope → pack 侧 fail-closed BLOCK（不执行任何工具）', async () => {
    const pack = createRecoverySiPack({ readPorts: READ_PORTS, bind: BIND });
    const evidence = await pack.run({
      task: { id: 'task-1', priority: 'P2', dedupeKey: SCAN_TASK_KEY },
      modelGateway: undefined,
    } as never);
    expect(evidence.status).toBe('BLOCK');
    expect(evidence.reasonCodes).toContain('RECOVERY_SCAN_SCOPE_LOADER_NOT_WIRED');
  });

  it('domainPacks 注入 recovery-si → RECOVERY_SI_RESERVED_PACK_ID_REJECTED（不能绕过共享 guard）', async () => {
    await expect(
      composeRsiRuntime({
        readFile: async () => '[]',
        domainPacks: [
          {
            packId: 'recovery-si',
            domain: 'recovery',
            matches: () => true,
            run: async () => ({ status: 'PASS', evidenceRef: 'forged' }),
          } as never,
        ],
      }),
    ).rejects.toThrow(/RECOVERY_SI_RESERVED_PACK_ID_REJECTED/);
  });

  it('未注入 scanScope 的生产组装不认领即不推进：composition 侧不产生任何 scan 写', async () => {
    const composition = await composeRsiRuntime({
      readFile: async (path: string) =>
        path === 'mem://tasks'
          ? JSON.stringify([{ id: 'task-1', dedupeKey: SCAN_TASK_KEY, priority: 'P2' }])
          : '[]',
      tasksPath: 'mem://tasks',
      productRecoveryPack: { appActionGuardDeps: undefined as never, readPorts: READ_PORTS, bind: BIND as never },
    }).catch((error: unknown) => error);
    // 生产组装点强制要求共享 guard 依赖；缺失即拒绝（不静默降级）
    expect(String((composition as Error).message)).toContain('RECOVERY_SI_PRODUCT_GUARD_REQUIRED');
  });
});

describe('PHASE 11 · 租户与外写边界（真实 PostgreSQL）', () => {
  it('跨租户装载 durable scan scope → BLOCK，且不修改目标租户的扫描行', async () => {
    const { created } = await seedScan(ORG);
    const before = await loadRecoveryScanById(prisma, { organizationId: ORG, scanId: created.row.id });

    const crossTenant = await loadScanScopeForClaimedTask(prisma, {
      organizationId: ORG_B,
      dedupeKey: created.row.dedupeKey,
    });
    expect(crossTenant.ok).toBe(false);

    const after = await loadRecoveryScanById(prisma, { organizationId: ORG, scanId: created.row.id });
    expect(after!.status).toBe(before!.status);
    expect(after!.recordsScanned).toBe(before!.recordsScanned);
    expect(after!.nextShardIndex).toBe(before!.nextShardIndex);
  });

  it('执行端口只写 scan scope/checkpoint：行数不变、状态推进，summary 外写恒为 false', async () => {
    const { taskKey, created } = await seedScan(ORG);
    const beforeCount = await prisma.recoveryScanRun.count();

    const executed = await createHistoricalScanExecutionPort(prisma).run({
      organizationId: ORG,
      taskKey,
      pagePort: {
        async fetchPage({ shard }) {
          return {
            records: [syntheticRecord('ENTRY-P11-' + shard.key)],
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
    expect(executed.ok).toBe(true);
    expect(executed.scanId).toBe(created.row.id);
    expect(executed.status).toBe('COMPLETED');

    // 只改既有行，不新建任何行（无第二事实源 / 无外部写副作用）
    expect(await prisma.recoveryScanRun.count()).toBe(beforeCount);

    const row = await loadRecoveryScanById(prisma, { organizationId: ORG, scanId: created.row.id });
    expect(row!.status).toBe('COMPLETED');
    const summary = buildScanSummaryView(row!);
    expect(summary.filingPerformed).toBe(false);
    expect(summary.paymentPerformed).toBe(false);
    expect(summary.externalWritePerformed).toBe(false);
    expect(summary.claimsFiled).toBe(0);
    expect(summary.coverage).toBe('SOURCE_LIMITED');
  });
});
