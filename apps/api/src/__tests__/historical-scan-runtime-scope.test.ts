// HISTORICAL_RECOVERY_SCAN_V1 / PHASE 3 —— durable scan scope → ONE SI Runtime（其 Recovery binding）
// 覆盖：扫描任务的 scope 必须来自 durable scan；缺失 / 租户不符 / 账户不符 / digest 不符 → BLOCK；
//       caller 自报范围不采用；非扫描任务不受影响（既有语义不变）。

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createRecoverySiPack, type RecoverySiPackDependencies } from '../runtime/recovery-si-pack';
import type { RecoveryReadPorts } from '../services/intelligence/recovery-read-tools';
import type { RsiSafeTask } from '../services/autonomy/rsi-continuation-engine';
import {
  assertScopeNotCallerOwned,
  isRecoveryScanTask,
  loadScanScopeForClaimedTask,
} from '../services/historical-scan/scan-scope-loader';
import { createOrGetRecoveryScan } from '../services/historical-scan/scan-store';

const prisma = new PrismaClient();

const ORG = 'c0ffee00-0000-4000-8000-00000000002a';
const ORG_B = 'c0ffee00-0000-4000-8000-00000000002b';
const USER = 'c0ffee00-0000-4000-8000-0000000000f3';
const DIGEST = 'b'.repeat(64);
const GOAL_ID = 'goal-' + DIGEST.slice(0, 24);

const readPorts: RecoveryReadPorts = {
  async opportunityRead(input) {
    return { opportunityRef: input.opportunityRef, status: 'READY', currency: 'USD', hasRecoverableAmount: true, hasRuleEvaluation: true };
  },
  async evidenceRead(input) {
    return { opportunityRef: input.opportunityRef, caseRef: 'case-1', evidenceCount: 2, kinds: ['ENTRY_RECORD'] };
  },
  async customsAuthorizationReadinessRead(input) {
    return { opportunityRef: input.opportunityRef, route: 'MODE_A', readyToFile: false, blockerCodes: ['POA_MISSING'] };
  },
};

const DENY_GUARD = { async evaluate() { return { decision: 'DENY' as const, reason: 'TEST_DENY' }; } };

function packDeps(over: Partial<RecoverySiPackDependencies> = {}): RecoverySiPackDependencies {
  return {
    readPorts,
    guard: DENY_GUARD,
    bind: (task) => {
      const match = /^task:recovery:([A-Z_]+):(.+)$/.exec(task.dedupeKey);
      if (match === null) return null;
      return {
        organizationId: ORG,
        domain: match[1] as never,
        actionKind: 'EXECUTE_READ_ONLY_CHECK',
        opportunityRef: match[2],
      };
    },
    ...over,
  };
}

const scanTask = (dedupeKey: string): RsiSafeTask => ({ id: 'task-scan-1', dedupeKey, priority: 'P2' });

async function truncate(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "RecoveryScanRun", "AgentGoalRun", "AgentGoal", "AuditLog", "Membership", "User", "Organization" CASCADE;',
  );
}

async function seedGoal(organizationId: string, goalId = GOAL_ID, digest = DIGEST): Promise<void> {
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
}

async function seedScan(organizationId = ORG) {
  return createOrGetRecoveryScan(prisma, {
    organizationId,
    goalId: GOAL_ID,
    goalDigest: DIGEST,
    domain: 'CUSTOMS',
    provider: 'CBP',
    platformAccountId: 'acct-1',
    requestedFrom: '2021-10-08',
    requestedTo: '2026-10-08',
    effectiveFrom: '2021-10-08',
    effectiveTo: '2026-10-08',
    requestedMonths: 60,
  });
}

beforeAll(async () => {
  await truncate();
  await prisma.organization.create({ data: { id: ORG, name: 'scan-runtime', slug: 'scan-runtime' } });
  await prisma.organization.create({ data: { id: ORG_B, name: 'scan-runtime-b', slug: 'scan-runtime-b' } });
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE "RecoveryScanRun" CASCADE;');
  await prisma.agentGoal.deleteMany({});
  await seedGoal(ORG);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('PHASE 3 · runtime scope loading（fail-closed）', () => {
  it('扫描任务识别：只有带 scan 身份的 dedupeKey 才走 durable scope', () => {
    expect(isRecoveryScanTask('task:recovery:CUSTOMS:scan:v1:abc:CUSTOMS:CBP:-:2021-10-08:2026-10-08:60')).toBe(true);
    expect(isRecoveryScanTask('task:recovery:CUSTOMS:opp-1')).toBe(false);
  });

  it('loader：有效 scan → 返回 server-owned scope（caller 自报范围被忽略）', async () => {
    const created = await seedScan();
    const loaded = await loadScanScopeForClaimedTask(prisma, {
      organizationId: ORG,
      dedupeKey: created.row.dedupeKey,
      assertedPlatformAccountId: 'acct-1',
      assertedRange: { from: '1990-01-01', to: '2030-01-01', months: 999 },
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.scope.requestedFrom).toBe('2021-10-08');
    expect(loaded.scope.requestedMonths).toBe(60);
    expect(loaded.scope.callerRangeTrusted).toBe(false);
    expect(loaded.reasonCodes).toContain('CALLER_RANGE_IGNORED_NOT_TRUSTED');
  });

  it('loader：缺失 scan / 跨租户 / 账户不符 → BLOCK', async () => {
    const created = await seedScan();

    const missing = await loadScanScopeForClaimedTask(prisma, {
      organizationId: ORG,
      dedupeKey: 'scan:v1:missing:0',
    });
    expect(missing.ok).toBe(false);
    expect(missing.ok === false && missing.reasonCodes).toContain('RECOVERY_SCAN_MISSING_OR_TENANT_MISMATCH');

    const crossTenant = await loadScanScopeForClaimedTask(prisma, {
      organizationId: ORG_B,
      dedupeKey: created.row.dedupeKey,
    });
    expect(crossTenant.ok).toBe(false);
    expect(crossTenant.ok === false && crossTenant.reasonCodes).toContain('RECOVERY_SCAN_MISSING_OR_TENANT_MISMATCH');

    const accountMismatch = await loadScanScopeForClaimedTask(prisma, {
      organizationId: ORG,
      dedupeKey: created.row.dedupeKey,
      assertedPlatformAccountId: 'acct-OTHER',
    });
    expect(accountMismatch.ok).toBe(false);
    expect(accountMismatch.ok === false && accountMismatch.reasonCodes).toContain('RECOVERY_SCAN_ACCOUNT_MISMATCH');
  });

  it('loader：task payload 试图携带范围字段 → 明确拒绝（不得成为第二事实源）', () => {
    expect(assertScopeNotCallerOwned({ from: '1990-01-01' }).ok).toBe(false);
    expect(assertScopeNotCallerOwned({ timeRange: { kind: 'LAST_N_MONTHS', months: 60 } }).ok).toBe(false);
    expect(assertScopeNotCallerOwned({ opportunityRef: 'opp-1' }).ok).toBe(true);
  });

  it('pack：扫描任务未注入 scanScope → BLOCK（绝不默认放行）', async () => {
    const pack = createRecoverySiPack(packDeps());
    const evidence = await pack.run({
      task: scanTask('task:recovery:CUSTOMS:scan:v1:abc:CUSTOMS:CBP:-:2021-10-08:2026-10-08:60'),
      packId: 'recovery-si',
    });
    expect(evidence.status).toBe('BLOCK');
    expect(evidence.reasonCodes).toContain('RECOVERY_SCAN_SCOPE_LOADER_NOT_WIRED');
  });

  it('pack：scanScope 返回 BLOCK（租户不符）→ 原样 BLOCK，且不进入后续执行', async () => {
    const pack = createRecoverySiPack(
      packDeps({
        scanScope: {
          async load() {
            return { ok: false, reasonCodes: ['RECOVERY_SCAN_TENANT_MISMATCH'] };
          },
        },
      }),
    );
    const evidence = await pack.run({
      task: scanTask('task:recovery:CUSTOMS:scan:v1:abc:CUSTOMS:CBP:-:2021-10-08:2026-10-08:60'),
      packId: 'recovery-si',
    });
    expect(evidence.status).toBe('BLOCK');
    expect(evidence.reasonCodes).toContain('RECOVERY_SCAN_SCOPE_BLOCKED');
    expect(evidence.reasonCodes).toContain('RECOVERY_SCAN_TENANT_MISMATCH');
  });

  it('pack：scope 装载成功后才继续既有流程（后续由既有 guard 决定，不被本次改动放宽）', async () => {
    let loaded = 0;
    const pack = createRecoverySiPack(
      packDeps({
        scanScope: {
          async load() {
            loaded += 1;
            return { ok: true, reasonCodes: [] };
          },
        },
      }),
    );
    const evidence = await pack.run({
      task: scanTask('task:recovery:CUSTOMS:scan:v1:abc:CUSTOMS:CBP:-:2021-10-08:2026-10-08:60'),
      packId: 'recovery-si',
    });
    expect(loaded).toBe(1);
    // 既有 guard 为 DENY → 仍然 BLOCK（本单元未放宽任何执行）
    expect(evidence.status).toBe('BLOCK');
    expect(evidence.reasonCodes.some((code) => code.startsWith('RECOVERY_GUARD') || code === 'TEST_DENY')).toBe(true);
  });

  it('pack：非扫描任务不受影响（不需要 scanScope 端口）', async () => {
    const pack = createRecoverySiPack(packDeps());
    const evidence = await pack.run({ task: scanTask('task:recovery:CUSTOMS:opp-1'), packId: 'recovery-si' });
    expect(evidence.reasonCodes).not.toContain('RECOVERY_SCAN_SCOPE_LOADER_NOT_WIRED');
    expect(evidence.status).toBe('BLOCK'); // 仍因既有 guard DENY 而 BLOCK
  });
});
