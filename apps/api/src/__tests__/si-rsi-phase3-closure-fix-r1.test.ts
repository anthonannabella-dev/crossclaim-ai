/**
 * PHASE 3 / `PHASE3_RECOVERY_DURABLE_CLOSURE_FIX_R1`（审计 MSG-20261009-02 批准的实现）
 * ---------------------------------------------------------------
 * 审计方指定的修复口径：`RUNTIME_VERDICT_AWARE_FENCED_SETTLEMENT`
 *   · 裁决收口后由**运行时**自动执行 **fenced settle**；「一律 BLOCKED」与「settle 交 host」均被拒绝；
 *   · PASS 且**具备可信业务完成证据**才可 COMPLETED；PASS 但只有 domain step 成功 ⇒ BLOCKED + `VERDICT_PASS_AWAITING_BUSINESS_PROOF`；
 *   · REJECT/DENY ⇒ BLOCKED；REVISE ⇒ 按未通过处理；裁决缺失/不可信 ⇒ SAFE_WAIT（不落终态、不视为 PASS）；
 *   · P0-5：先写 durable INTENT 再 settle ⇒ 崩溃后可恢复待收口决策（**不重跑 domain step**）；
 *   · P0-6：不得把审计幂等当执行幂等（本文件用只读端口计数证明「不重复执行」）。
 *
 * 本文件覆盖：R1、R2、R3、R4、R5、R6、R8（R7 的租户/授权复核由既有 claim 门禁与 fenced settle 共同保证，见断言）；
 * 真实 PostgreSQL；不新增任何 runtime / scheduler / controller。
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  RECOVERY_SETTLEMENT_APPLIED_ACTION,
  RECOVERY_SETTLEMENT_INTENT_ACTION,
  RECOVERY_SETTLEMENT_REFUSAL,
  RECOVERY_SETTLEMENT_REASON,
  createRecoveryVerdictSettlement,
  decideRecoverySettlement,
} from '../runtime/recovery-verdict-settlement';
import { createRecoveryDomainOutcomeRecorder } from '../runtime/recovery-domain-outcome-recorder';
import { createTestTerminalEvidenceSource } from '../runtime/recovery-terminal-evidence';
import type { RecoveryTerminalEvidence } from '../runtime/recovery-terminal-evidence';
import { createProductionRecoveryPackDeps } from '../runtime/recovery-si-production-composition';
import { DEFAULT_RUNTIME_OWNER_REF, composeRsiRuntime } from '../runtime/rsi-run';
import { createAutonomyTaskSource } from '../runtime/rsi-durable-task-source';
import { createPrismaTaskQueuePort } from '../services/agent-goal/prisma-task-queue-port';
import type { GoalTaskDraft } from '../services/agent-goal/goal-task-planner';

const prisma = new PrismaClient();
const T0 = new Date('2026-10-08T12:00:00.000Z');
const ORG = 'closure-org';
const suffix = (): string => randomUUID().replace(/-/g, '').slice(0, 10);
const DOMAIN_ACTION = 'RECOVERY_DOMAIN_STEP_EXECUTED';

const draft = (dedupeKey: string): GoalTaskDraft => ({
  domain: 'LOGISTICS',
  dedupeKey,
  candidateActions: [],
  autoExecutableActions: [],
  blockedActions: [],
  executionMode: 'AUTO_WHEN_AUTHORIZED',
  requiresStandingAuthorizationForAutoExecution: true,
});

async function seedTenant(): Promise<void> {
  await prisma.organization.upsert({ where: { id: ORG }, create: { id: ORG, name: ORG, slug: ORG }, update: {} });
  await prisma.standingAuthorization.deleteMany({ where: { organizationId: ORG } });
  await prisma.standingAuthorization.create({
    data: {
      organizationId: ORG,
      platformAccountId: 'acct-closure',
      provider: 'AMAZON',
      allowedActionTypes: ['recovery.read'],
      monetaryLimitUsd: '0',
      currency: 'USD',
      domain: 'LOGISTICS',
      jurisdiction: 'US',
      effectiveAt: new Date('2026-10-08T00:00:00.000Z'),
      expiresAt: new Date('2026-11-08T00:00:00.000Z'),
      authorizationVersion: 1,
      termsPolicyVersion: 'v1',
      consentEvidenceRef: 'evidence://closure-seed',
      scopeDigest: 'a'.repeat(64),
      revocationState: 'ACTIVE',
      createdAt: T0,
    },
  });
}

async function seedOpportunity(opportunityRef: string): Promise<void> {
  await prisma.recoveryOpportunity.create({
    data: {
      id: opportunityRef,
      organizationId: ORG,
      domain: 'LOGISTICS',
      channel: 'FEDEX',
      status: 'DETECTED',
      opportunityType: 'RATE_DISCREPANCY',
      title: 'closure ' + opportunityRef,
      amountExpected: '100.0000',
      amountActual: '150.0000',
      recoverableAmount: '50.0000',
      currency: 'USD',
      detectedAt: T0,
      createdAt: T0,
    },
  });
}

async function truncateAll(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AutonomyLease", "AutonomyTask", "AutonomyIncident", "AuditLog", "RecoveryOpportunity" CASCADE;',
  );
}

/** 组装「运行时 + 已接线 settlement 端口」的生产同构组合（port 与 runtime 共用同一 ownerRef） */
async function composeWired(input: {
  verdictArtifact: string;
  ownerRef: string;
  onReadPort?: () => void;
  trustedCompletionEvidenceRef?: string;
  /** R2 正向路径：host 提供的**已校验**终局证据（是否被接受仍由 settle 的事务内白名单决定） */
  trustedEvidence?: (request: { taskId: string; dedupeKey: string }) => Promise<RecoveryTerminalEvidence | undefined>;
  /** R2 负向：显式注入终端证据来源（缺省 = 生产注册表，全部 disabled） */
  terminalEvidenceSources?: readonly ReturnType<typeof createTestTerminalEvidenceSource>[];
}) {
  const packDeps = createProductionRecoveryPackDeps({ prisma });
  const readPorts = {
    ...packDeps.readPorts,
    async opportunityRead(portInput: { organizationId: string; opportunityRef: string }) {
      input.onReadPort?.();
      return packDeps.readPorts.opportunityRead(portInput);
    },
  };
  const taskSource = createAutonomyTaskSource({
    prisma,
    ownerRef: input.ownerRef,
    now: () => T0,
    ...(input.terminalEvidenceSources === undefined
      ? {}
      : { terminalEvidenceSources: input.terminalEvidenceSources }),
  });
  const settlement = createRecoveryVerdictSettlement({
    prisma,
    taskSource,
    ownerRef: input.ownerRef,
    ...(input.trustedEvidence === undefined
      ? {}
      : {
          trustedEvidenceProvider: async (request: { taskId: string; dedupeKey: string }) =>
            input.trustedEvidence!(request),
        }),
    now: () => T0,
  });
  const composition = await composeRsiRuntime({
    readFile: async (path: string) => (path === 'mem://verdict' ? input.verdictArtifact : '[]'),
    verdictPath: 'mem://verdict',
    verdictWatch: { intervalMs: 10_000 },
    intervalMs: 50,
    runtimeOwnerRef: input.ownerRef,
    taskSource,
    productRecoveryPack: { ...packDeps, readPorts },
    recoveryVerdictSettlement: {
      async settleAfterVerdict(request) {
        return settlement.settleAfterVerdict({
          ...request,
          ...(input.trustedCompletionEvidenceRef === undefined
            ? {}
            : { trustedCompletionEvidenceRef: input.trustedCompletionEvidenceRef }),
        });
      },
    },
    onDomainPackEvidence: (record) => createRecoveryDomainOutcomeRecorder({ prisma, now: () => T0 }).record(record).then(() => undefined),
  });
  return { composition, settlement };
}

async function admitted(prefix = 'task:recovery:LOGISTICS:'): Promise<{ key: string; taskId: string }> {
  const opportunityRef = suffix();
  await seedOpportunity(opportunityRef);
  const key = prefix + opportunityRef;
  await createPrismaTaskQueuePort({ prisma, now: () => T0 }).admit({ organizationId: ORG, tasks: [draft(key)] });
  return { key, taskId: '' };
}

const settleRows = (taskId: string, action: string) =>
  prisma.auditLog.findMany({
    where: { organizationId: ORG, action, entityType: 'AutonomyTask', entityId: taskId },
    orderBy: { createdAt: 'asc' },
    select: { changes: true },
  });

beforeEach(async () => {
  await truncateAll();
  await seedTenant();
});

afterAll(async () => {
  await truncateAll();
  await prisma.standingAuthorization.deleteMany({ where: { organizationId: ORG } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
  await prisma.$disconnect();
});

describe('PHASE 3 / R1 运行时裁决感知收口（RUNTIME_VERDICT_AWARE_FENCED_SETTLEMENT）', () => {
  it('R2（正向）：PASS + host 已校验终局证据 + 显式启用可信来源 ⇒ 运行时收口到完成级状态（PROMOTED）', async () => {
    const { key } = await admitted();
    const testSources = [createTestTerminalEvidenceSource()];
    const { composition } = await composeWired({
      verdictArtifact: JSON.stringify({ messageId: 'closure-msg-complete', verdict: 'PASS' }),
      ownerRef: 'closure-worker-complete',
      terminalEvidenceSources: testSources,
      trustedEvidence: async (request) => ({
        kind: 'SETTLEMENT_LEDGER_ENTRY',
        source: 'SETTLEMENT_LEDGER',
        verified: true,
        verifiedBy: 'SETTLEMENT_EVIDENCE_VERIFIER',
        verificationRef: 'test://settlement/' + request.dedupeKey,
        providerEventId: 'evt-' + request.dedupeKey,
        observedAt: T0.toISOString(),
        organizationId: ORG,
        taskDedupeKey: request.dedupeKey,
      }),
    });
    let taskId = '';
    try {
      const outcome = await composition.controller.tick();
      taskId = outcome.claimed!.id;
      await composition.verdictWatcher!.pollOnce();
    } finally {
      composition.stop();
    }

    const task = await prisma.autonomyTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.status).toBe('PROMOTED'); // 唯一允许完成级状态的路径（可信证据 + 白名单来源启用）
    expect((await prisma.autonomyLease.findUniqueOrThrow({ where: { taskId } })).status).toBe('RELEASED');
    const applied = await settleRows(taskId, RECOVERY_SETTLEMENT_APPLIED_ACTION);
    const changes = applied[0]!.changes as Record<string, unknown>;
    expect(changes.decidedAction).toBe('SETTLE_COMPLETED');
    expect(changes.reasonCode).toBe(RECOVERY_SETTLEMENT_REASON.PASS_WITH_TRUSTED_COMPLETION);
    expect(changes.afterStatus).toBe('PROMOTED');
    expect(String(changes.trustedCompletionEvidenceRef)).toBe('test://settlement/' + key);
  });

  it('R2（fail-closed）：端口声称有终局证据但**白名单来源未启用** ⇒ 回落非完成收口（不留 IN_PROGRESS 悬挂）', async () => {
    await admitted();
    const { composition } = await composeWired({
      verdictArtifact: JSON.stringify({ messageId: 'closure-msg-untrusted', verdict: 'PASS' }),
      ownerRef: 'closure-worker-untrusted',
      // 不注入 terminalEvidenceSources ⇒ 使用**生产注册表（全部 disabled）**
      trustedEvidence: async (request) => ({
        kind: 'SETTLEMENT_LEDGER_ENTRY',
        source: 'SETTLEMENT_LEDGER',
        verified: true,
        verifiedBy: 'SETTLEMENT_EVIDENCE_VERIFIER',
        verificationRef: 'test://settlement/' + request.dedupeKey,
        providerEventId: 'evt-' + request.dedupeKey,
        observedAt: T0.toISOString(),
        organizationId: ORG,
        taskDedupeKey: request.dedupeKey,
      }),
    });
    let taskId = '';
    try {
      const outcome = await composition.controller.tick();
      taskId = outcome.claimed!.id;
      await composition.verdictWatcher!.pollOnce();
    } finally {
      composition.stop();
    }

    const task = await prisma.autonomyTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.status).toBe('BLOCKED'); // 声称证据 ≠ 被接受；绝不 PROMOTED，也绝不悬挂
    const applied = await settleRows(taskId, RECOVERY_SETTLEMENT_APPLIED_ACTION);
    const changes = applied[0]!.changes as Record<string, unknown>;
    expect(changes.decidedAction).toBe('SETTLE_COMPLETED');
    expect(changes.decisionAction).toBe('SETTLE_BLOCKED');
    expect(changes.reasonCode).toBe(RECOVERY_SETTLEMENT_REASON.COMPLETION_REFUSED_FALLBACK_BLOCKED);
    expect(changes.settleApplied).toBe(true);
  });

  it('决策表（纯函数）：PASS 仅在有可信完成证据时才 COMPLETED；缺失/不可信裁决 ⇒ SAFE_WAIT', () => {
    expect(decideRecoverySettlement({ verdict: 'PASS' }).action).toBe('SETTLE_BLOCKED');
    expect(decideRecoverySettlement({ verdict: 'PASS' }).reason).toBe(
      RECOVERY_SETTLEMENT_REASON.PASS_AWAITING_BUSINESS_PROOF,
    );
    expect(decideRecoverySettlement({ verdict: 'PASS', trustedCompletionEvidence: true }).action).toBe('SETTLE_COMPLETED');
    expect(decideRecoverySettlement({ verdict: 'BLOCK' }).reason).toBe(RECOVERY_SETTLEMENT_REASON.REJECTED);
    expect(decideRecoverySettlement({ verdict: 'REVISE' }).reason).toBe(RECOVERY_SETTLEMENT_REASON.REVISED);
    expect(decideRecoverySettlement({ verdict: null }).action).toBe('SAFE_WAIT');
    expect(decideRecoverySettlement({ verdict: undefined }).action).toBe('SAFE_WAIT');
  });

  it('R1 + R2 + R3 + R8：PASS 裁决 ⇒ 运行时自动 fenced settle 到 BLOCKED（非完成），租约 RELEASED，重复 tick 不再执行', async () => {
    const { key: admittedKey } = await admitted();
    let readPortCalls = 0;
    const { composition } = await composeWired({
      verdictArtifact: JSON.stringify({ messageId: 'closure-msg-1', verdict: 'PASS' }),
      ownerRef: 'closure-worker-1',
      onReadPort: () => {
        readPortCalls += 1;
      },
    });
    let taskId = '';
    try {
      const outcome = await composition.controller.tick();
      taskId = outcome.claimed!.id;
      expect(admittedKey.startsWith('task:recovery:')).toBe(true);
      expect(readPortCalls).toBe(1); // domain step 执行一次
      expect(composition.controller.state().waitingForVerdict).toBe(true);

      // 真实 verdictWatcher 收口 ⇒ 运行时自动 settle（**没有**人为调用 settle）
      const polled = await composition.verdictWatcher!.pollOnce();
      expect(polled.delivered).toBe(true);
    } finally {
      composition.stop();
    }

    const task = await prisma.autonomyTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.status).toBe('BLOCKED'); // R2：无完成证据 ⇒ 绝不 COMPLETED / PROMOTED
    expect(task.status).not.toBe('PROMOTED');
    expect((await prisma.autonomyLease.findUniqueOrThrow({ where: { taskId } })).status).toBe('RELEASED'); // R3

    // R8：收口审计可追踪（INTENT → APPLIED，含 verdictRef / reasonCode / 前后状态 / owner）
    const intents = await settleRows(taskId, RECOVERY_SETTLEMENT_INTENT_ACTION);
    const applied = await settleRows(taskId, RECOVERY_SETTLEMENT_APPLIED_ACTION);
    expect(intents).toHaveLength(1);
    expect(applied).toHaveLength(1);
    const appliedChanges = applied[0]!.changes as Record<string, unknown>;
    expect(appliedChanges.verdictRef).toBe('closure-msg-1');
    expect(appliedChanges.reasonCode).toBe(RECOVERY_SETTLEMENT_REASON.PASS_AWAITING_BUSINESS_PROOF);
    expect(appliedChanges.beforeStatus).toBe('IN_PROGRESS');
    expect(appliedChanges.afterStatus).toBe('BLOCKED');
    expect(appliedChanges.ownerRef).toBe('closure-worker-1');
    expect(appliedChanges.settleApplied).toBe(true);

    // R3：收口之后重复 tick 不再重复执行
    const again = await composeWired({
      verdictArtifact: JSON.stringify({ messageId: 'closure-msg-2', verdict: 'PASS' }),
      ownerRef: 'closure-worker-2',
      onReadPort: () => {
        readPortCalls += 1;
      },
    });
    try {
      const outcome = await again.composition.controller.tick();
      expect(outcome.claimed).toBeNull();
    } finally {
      again.composition.stop();
    }
    expect(readPortCalls).toBe(1);
    expect(await prisma.auditLog.count({ where: { organizationId: ORG, action: DOMAIN_ACTION, entityId: taskId } })).toBe(1);
  });

  it('R6：BLOCK 与 REVISE 裁决都按「未通过」收口（各自 reason code），且都不产生完成级状态', async () => {
    for (const [verdict, expectedReason] of [
      ['BLOCK', RECOVERY_SETTLEMENT_REASON.REJECTED],
      ['REVISE', RECOVERY_SETTLEMENT_REASON.REVISED],
    ] as const) {
      await truncateAll();
      await seedTenant();
      const { key } = await admitted();
      const { composition } = await composeWired({
        verdictArtifact: JSON.stringify({ messageId: 'closure-msg-' + verdict, verdict }),
        ownerRef: 'closure-worker-' + verdict,
      });
      let taskId = '';
      try {
        const outcome = await composition.controller.tick();
        taskId = outcome.claimed!.id;
        await composition.verdictWatcher!.pollOnce();
      } finally {
        composition.stop();
      }
      const task = await prisma.autonomyTask.findUniqueOrThrow({ where: { id: taskId } });
      expect(task.status).toBe('BLOCKED');
      const applied = await settleRows(taskId, RECOVERY_SETTLEMENT_APPLIED_ACTION);
      expect((applied[0]!.changes as Record<string, unknown>).reasonCode).toBe(expectedReason);
      expect(await prisma.autonomyTask.count({ where: { dedupeKey: key, status: 'PROMOTED' } })).toBe(0);
    }
  });

  it('R5（P0-5 崩溃恢复）：已有 durable INTENT 但未 APPLIED ⇒ 重启后恢复收口，且**不重跑** domain step', async () => {
    const { key } = await admitted();
    let readPortCalls = 0;
    const first = await composeWired({
      verdictArtifact: JSON.stringify({ messageId: 'closure-msg-crash', verdict: 'PASS' }),
      ownerRef: 'closure-worker-crash',
      onReadPort: () => {
        readPortCalls += 1;
      },
    });
    let taskId = '';
    try {
      const outcome = await first.composition.controller.tick();
      taskId = outcome.claimed!.id;
    } finally {
      first.composition.stop();
    }
    expect(readPortCalls).toBe(1);
    // 模拟「verdict 已持久化、但运行时在 settle 前崩溃」：手工写入与运行时同形的 INTENT（不含 APPLIED）
    await prisma.auditLog.create({
      data: {
        organizationId: ORG,
        actorType: 'SYSTEM',
        actorRef: 'rsi-run:verdict-settlement',
        action: RECOVERY_SETTLEMENT_INTENT_ACTION,
        entityType: 'AutonomyTask',
        entityId: taskId,
        changes: {
          dedupeKey: key,
          ownerRef: 'closure-worker-crash',
          verdict: 'PASS',
          verdictRef: 'closure-msg-crash',
          intentKey: `${taskId}|closure-msg-crash`,
          recordedAt: T0.toISOString(),
        },
      },
    });

    // 重启：新的 owner + 新的 settlement 端口，恢复待收口决策（走既有 fenced settle）
    const restartedOwner = 'closure-worker-restarted';
    // 崩溃的旧 owner 仍持租约 ⇒ 先由既有恢复路径接管（reclaimExpired 需要租约到期）
    await prisma.autonomyLease.update({
      where: { taskId },
      data: {
        acquiredAt: new Date('2026-10-08T11:50:00.000Z'),
        renewedAt: new Date('2026-10-08T11:50:00.000Z'),
        expiresAt: new Date('2026-10-08T11:59:00.000Z'),
      },
    });
    const restartedSource = createAutonomyTaskSource({ prisma, ownerRef: restartedOwner, now: () => T0 });
    await restartedSource.reclaimExpired(5);
    await restartedSource.claim(5);
    const restartedSettlement = createRecoveryVerdictSettlement({
      prisma,
      taskSource: restartedSource,
      ownerRef: restartedOwner,
      now: () => T0,
    });
    const resumed = await restartedSettlement.resumePendingSettlements(ORG);
    expect(resumed.length).toBeGreaterThan(0);

    expect((await prisma.autonomyTask.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('BLOCKED');
    expect(readPortCalls).toBe(1); // 恢复过程**没有**重跑 domain step（P0-5 明确禁止）
    expect((await settleRows(taskId, RECOVERY_SETTLEMENT_APPLIED_ACTION)).length).toBe(1);
  });

  it('R4：旧 owner / 过期租约不得覆盖新 owner 的收口（由既有 fenced settle 拒绝）', async () => {
    const { key } = await admitted();
    const staleOwner = 'closure-worker-stale';
    const freshOwner = 'closure-worker-fresh';

    const staleSource = createAutonomyTaskSource({ prisma, ownerRef: staleOwner, now: () => T0 });
    await createPrismaTaskQueuePort({ prisma, now: () => T0 }).admit({
      organizationId: ORG,
      tasks: [draft(key)],
    });
    await staleSource.claim(5);
    const taskId = (await prisma.autonomyTask.findFirstOrThrow({ where: { dedupeKey: key } })).id;
    await prisma.autonomyLease.update({
      where: { taskId },
      data: {
        acquiredAt: new Date('2026-10-08T11:50:00.000Z'),
        renewedAt: new Date('2026-10-08T11:50:00.000Z'),
        expiresAt: new Date('2026-10-08T11:59:00.000Z'),
      },
    });

    const freshSource = createAutonomyTaskSource({ prisma, ownerRef: freshOwner, now: () => T0 });
    await freshSource.reclaimExpired(5);
    await freshSource.claim(5);

    const staleSettlement = createRecoveryVerdictSettlement({ prisma, taskSource: staleSource, now: () => T0 });
    const denied = await staleSettlement.settleAfterVerdict({
      taskId,
      dedupeKey: key,
      organizationId: ORG,
      ownerRef: staleOwner,
      verdict: 'PASS',
      verdictRef: 'closure-msg-stale',
    });
    expect(denied.applied).toBe(false);
    expect(String(denied.reason)).toMatch(/FENCED_/);
    const task = await prisma.autonomyTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.status).toBe('IN_PROGRESS'); // 旧 owner 未能覆盖
    expect((await prisma.autonomyLease.findUniqueOrThrow({ where: { taskId } })).ownerRef).toBe(freshOwner);

    // 新 owner 可以正常收口
    const freshSettlement = createRecoveryVerdictSettlement({ prisma, taskSource: freshSource, now: () => T0 });
    const applied = await freshSettlement.settleAfterVerdict({
      taskId,
      dedupeKey: key,
      organizationId: ORG,
      ownerRef: freshOwner,
      verdict: 'PASS',
      verdictRef: 'closure-msg-fresh',
    });
    expect(applied.applied).toBe(true);
    expect((await prisma.autonomyTask.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('BLOCKED');
  });

  it('R7：跨租户 fail-closed —— 请求租户与任务权威租户不一致时拒绝收口且不写任何行', async () => {
    const { key } = await admitted();
    const other = await prisma.organization.create({
      data: { id: 'closure-org-other', name: 'other', slug: 'closure-org-other' },
    });
    try {
      const ownerRef = 'closure-worker-tenant';
      const source = createAutonomyTaskSource({ prisma, ownerRef, now: () => T0 });
      await source.claim(5);
      const taskId = (await prisma.autonomyTask.findFirstOrThrow({ where: { dedupeKey: key } })).id;
      const settlement = createRecoveryVerdictSettlement({ prisma, taskSource: source, ownerRef, now: () => T0 });

      // 用**别的租户**的 organizationId 去收口 ⇒ 必须 fail-closed 拒绝（不写 intent / 不写 applied / 不改状态）
      const refused = await settlement.settleAfterVerdict({
        taskId,
        dedupeKey: key,
        organizationId: other.id,
        ownerRef,
        verdict: 'BLOCK',
        verdictRef: 'closure-msg-tenant',
      });
      expect(refused.applied).toBe(false);
      expect(refused.reason).toBe(RECOVERY_SETTLEMENT_REFUSAL.TENANT_MISMATCH);
      expect(
        await prisma.auditLog.count({
          where: {
            entityId: taskId,
            action: { in: [RECOVERY_SETTLEMENT_INTENT_ACTION, RECOVERY_SETTLEMENT_APPLIED_ACTION] },
          },
        }),
      ).toBe(0); // 任何租户名下都没有 settlement 记录
      expect((await prisma.autonomyTask.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('IN_PROGRESS');

      // 权威租户（本任务真实租户）可以正常收口
      const ok = await settlement.settleAfterVerdict({
        taskId,
        dedupeKey: key,
        organizationId: ORG,
        ownerRef,
        verdict: 'BLOCK',
        verdictRef: 'closure-msg-tenant-ok',
      });
      expect(ok.applied).toBe(true);
      expect((await prisma.autonomyTask.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('BLOCKED');
      expect(DEFAULT_RUNTIME_OWNER_REF.length).toBeGreaterThan(0);
    } finally {
      await prisma.organization.deleteMany({ where: { id: other.id } });
    }
  });
});
