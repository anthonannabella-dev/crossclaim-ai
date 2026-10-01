/**
 * R37 P3 —— platform.write 编排（T1 执行权 + 同事务审批消费 → T2 投递 → T3 收敛）
 * ---------------------------------------------------------------------------
 * 真实 PostgreSQL；transport 双重门控的「未放行」路径必须零账本、零消费、零投递。
 * 覆盖 INTEGRATION-BOUNDARY-REVIEW-PLAN §8 的 H5（重放同一链）/ H6（并发唯一链）/
 * H8（断连后重试不重发）在编排层的等价证据（HTTP 层 H1–H4/H7 见 platform-write-http-db）。
 */

import { createHash, randomUUID } from 'node:crypto';

import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hashPassword } from '../services/auth';
import { submitRecoveryReview } from '../services/workflow/recovery-review';
import {
  registerAdapterCapability,
  resetAdapterCapabilityRegistry,
} from '../services/platform-write/adapter-capability';
import { createPrismaPlatformWriteApprovalInTxPort } from '../services/platform-write/approval-tx-port';
import { runPlatformWriteAttempt } from '../services/platform-write/orchestrator';
import { PlatformWriteLedgerError } from '../services/platform-write/prisma-ledger';
import { createSimulatedPlatformWritePort } from '../services/platform-write/simulated-adapter';
import {
  PLATFORM_WRITE_ACTION,
  PLATFORM_WRITE_SNAPSHOT_VERSION,
} from '../services/platform-write/types';

const prisma = new PrismaClient();
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'platform-write-orch-pass-1';
const PLATFORM = 'amazon-sp';
const NOW = new Date(Date.now() - 60_000);

let ORG = '';
let ownerId = '';
let caseId = '';
let claimId = '';
let DIGEST = '';
let IDEMPOTENCY_KEY = '';

const approvals = createPrismaPlatformWriteApprovalInTxPort();

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  const tables = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations')",
  );
  if (tables.length > 0) {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE ' + tables.map((row) => '"' + row.tablename + '"').join(', ') + ' CASCADE;',
    );
  }
  await prisma.$disconnect();
});

beforeEach(async () => {
  resetAdapterCapabilityRegistry();
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  ORG = randomUUID();
  await prisma.organization.create({
    data: { id: ORG, name: 'platform.write 编排租户', slug: 'pw-orch-' + suffix },
  });
  const owner = await prisma.user.create({
    data: {
      email: 'pw-orch-' + suffix + '@example.com',
      passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
      displayName: 'OWNER',
      status: 'ACTIVE',
      emailVerified: true,
    },
  });
  ownerId = owner.id;
  await prisma.membership.create({
    data: { organizationId: ORG, userId: owner.id, role: 'OWNER', isActive: true },
  });
  const kase = await prisma.case.create({
    data: {
      organizationId: ORG,
      caseNo: 'CS-' + suffix,
      title: 'platform.write 编排用例',
      domain: 'LOGISTICS',
      status: 'WON',
      claimedAmount: new Prisma.Decimal('5000.0000'),
      currency: 'USD',
    },
  });
  caseId = kase.id;
  const claim = await prisma.claim.create({
    data: { organizationId: ORG, caseId, round: 1, status: 'DRAFT', target: 'CARRIER', aiDraftText: 'draft' },
  });
  claimId = claim.id;

  DIGEST = createHash('sha256').update('platform-write-orchestrator/' + suffix).digest('hex');
  IDEMPOTENCY_KEY =
    'pw1-' + createHash('sha256').update(PLATFORM_WRITE_SNAPSHOT_VERSION + '|' + DIGEST).digest('hex').slice(0, 40);
});

async function seedApproval(
  basis: string = DIGEST,
  boundAction: string = PLATFORM_WRITE_ACTION,
  money: { recoveredAmount?: string; currency?: string } = {},
): Promise<string> {
  await submitRecoveryReview(
    prisma,
    {
      organizationId: ORG,
      actorUserId: ownerId,
      role: 'OWNER',
      caseId,
      decision: 'REQUEST',
      recoveredAmount: null,
      currency: null,
    } as never,
    () => NOW,
  );
  const approved = (await submitRecoveryReview(
    prisma,
    {
      organizationId: ORG,
      actorUserId: ownerId,
      role: 'OWNER',
      caseId,
      decision: 'APPROVE',
      boundAction,
      boundPayload: {
        basisReference: basis,
        ...(money.recoveredAmount !== undefined ? { recoveredAmount: money.recoveredAmount } : {}),
        ...(money.currency !== undefined ? { currency: money.currency } : {}),
      },
    } as never,
    () => new Date(NOW.getTime() + 1000),
  )) as { approvalId?: string };
  if (!approved.approvalId) throw new Error('APPROVAL_NOT_CREATED');
  return approved.approvalId;
}

function registerEligibleAdapter(platform: string = PLATFORM): void {
  registerAdapterCapability({
    platform,
    idempotentWrite: true,
    statusQuery: true,
    ambiguousResponseSemantics: true,
  });
}

function attemptInput(approvalId: string | null, overrides: Record<string, unknown> = {}) {
  return {
    organizationId: ORG,
    caseId,
    targetKind: 'CLAIM' as const,
    targetId: claimId,
    platform: PLATFORM,
    snapshotVersion: PLATFORM_WRITE_SNAPSHOT_VERSION,
    snapshotDigest: DIGEST,
    idempotencyKey: IDEMPOTENCY_KEY,
    actorUserId: ownerId,
    approvalId,
    ...overrides,
  };
}

async function sideEffects() {
  return {
    attempts: await prisma.platformWriteAttempt.count({ where: { organizationId: ORG } }),
    consumed: await prisma.auditLog.count({
      where: { organizationId: ORG, action: 'recovery.approval_consumed' },
    }),
  };
}

describe('R37 P3 — platform.write T1/T2/T3 编排（真实 PostgreSQL）', () => {
  it('01 全局 transport gate 关闭 → NEEDS_MANUAL，零账本零消费零投递', async () => {
    registerEligibleAdapter();
    const approvalId = await seedApproval();
    const sink = createSimulatedPlatformWritePort('SIMULATED');
    const result = await runPlatformWriteAttempt(
      prisma,
      { approvals, sink, authorizationValid: true },
      attemptInput(approvalId),
    );
    expect(result.status).toBe('NEEDS_MANUAL');
    expect(result.code).toBe('GLOBAL_GATE_DISABLED');
    expect(result.attemptId).toBeNull();
    expect(result.sinkCalls).toBe(0);
    expect(sink.callCount()).toBe(0);
    expect(await sideEffects()).toEqual({ attempts: 0, consumed: 0 });
  }, 60_000);

  it('02 adapter 未注册（能力缺失）→ NEEDS_MANUAL 且零副作用', async () => {
    const approvalId = await seedApproval();
    const sink = createSimulatedPlatformWritePort('SIMULATED');
    const result = await runPlatformWriteAttempt(
      prisma,
      { approvals, sink, globalTransportEnabled: true, authorizationValid: true },
      attemptInput(approvalId),
    );
    expect(result.status).toBe('NEEDS_MANUAL');
    expect(result.code).toBe('ADAPTER_NOT_ELIGIBLE');
    expect(sink.callCount()).toBe(0);
    expect(await sideEffects()).toEqual({ attempts: 0, consumed: 0 });
  }, 60_000);

  it('03 授权无效（守卫未放行）→ NEEDS_MANUAL 且零副作用', async () => {
    registerEligibleAdapter();
    const approvalId = await seedApproval();
    const sink = createSimulatedPlatformWritePort('SIMULATED');
    const result = await runPlatformWriteAttempt(
      prisma,
      { approvals, sink, globalTransportEnabled: true, authorizationValid: false },
      attemptInput(approvalId),
    );
    expect(result.status).toBe('NEEDS_MANUAL');
    expect(result.code).toBe('AUTHORIZATION_INVALID');
    expect(sink.callCount()).toBe(0);
    expect(await sideEffects()).toEqual({ attempts: 0, consumed: 0 });
  }, 60_000);

  it('04 缺 approvalId（gate 放行）→ NEEDS_MANUAL，零 attempt 零消费', async () => {
    registerEligibleAdapter();
    const sink = createSimulatedPlatformWritePort('SIMULATED');
    const result = await runPlatformWriteAttempt(
      prisma,
      { approvals, sink, globalTransportEnabled: true, authorizationValid: true },
      attemptInput(null),
    );
    expect(result.status).toBe('NEEDS_MANUAL');
    expect(result.code).toBe('PLATFORM_WRITE_APPROVAL_REQUIRED');
    expect(sink.callCount()).toBe(0);
    expect(await sideEffects()).toEqual({ attempts: 0, consumed: 0 });
  }, 60_000);

  it('05 正常链路 → T1 取得执行权 + 同事务消费 + T3 收敛 SUCCEEDED', async () => {
    registerEligibleAdapter();
    const approvalId = await seedApproval();
    const sink = createSimulatedPlatformWritePort('SIMULATED');
    const result = await runPlatformWriteAttempt(
      prisma,
      { approvals, sink, globalTransportEnabled: true, authorizationValid: true },
      attemptInput(approvalId),
    );
    expect(result.status).toBe('SUCCEEDED');
    expect(result.providerRef).toMatch(/^SIMULATED-REF-/);
    expect(result.sinkCalls).toBe(1);

    const row = await prisma.platformWriteAttempt.findFirstOrThrow({ where: { organizationId: ORG } });
    expect(row.status).toBe('SUCCEEDED');
    expect(row.approvalId).toBe(approvalId);
    expect(row.snapshotDigest).toBe(DIGEST);
    expect(row.idempotencyKey).toBe(IDEMPOTENCY_KEY);
    expect(row.simulated).toBe(false);
    expect(await sideEffects()).toEqual({ attempts: 1, consumed: 1 });
  }, 60_000);

  it('06 H5 重放同一负载 → 同一条链（REPLAYED），不新增尝试、不重复消费、不再投递', async () => {
    registerEligibleAdapter();
    const approvalId = await seedApproval();
    const sink = createSimulatedPlatformWritePort('SIMULATED');
    const deps = { approvals, sink, globalTransportEnabled: true, authorizationValid: true };

    const first = await runPlatformWriteAttempt(prisma, deps, attemptInput(approvalId));
    expect(first.status).toBe('SUCCEEDED');
    const replay = await runPlatformWriteAttempt(prisma, deps, attemptInput(approvalId));
    expect(replay.status).toBe('REPLAYED');
    expect(replay.sinkCalls).toBe(0);
    expect(replay.attemptId).toBe(first.attemptId);
    expect(sink.callCount()).toBe(1);
    expect(await sideEffects()).toEqual({ attempts: 1, consumed: 1 });
  }, 60_000);

  it('07 H6 并发同一负载 → 恰一次取得执行权（唯一执行链）', async () => {
    registerEligibleAdapter();
    const approvalId = await seedApproval();
    const sink = createSimulatedPlatformWritePort('SIMULATED');
    const deps = { approvals, sink, globalTransportEnabled: true, authorizationValid: true };

    const results = await Promise.all([
      runPlatformWriteAttempt(prisma, deps, attemptInput(approvalId)),
      runPlatformWriteAttempt(prisma, deps, attemptInput(approvalId)),
      runPlatformWriteAttempt(prisma, deps, attemptInput(approvalId)),
    ]);
    expect(results.filter((r) => r.status === 'SUCCEEDED')).toHaveLength(1);
    expect(sink.callCount()).toBe(1);
    expect(await sideEffects()).toEqual({ attempts: 1, consumed: 1 });
  }, 60_000);

  it('08 审批绑定到其他摘要 → T1 拒绝且零 attempt 零消费', async () => {
    registerEligibleAdapter();
    const approvalId = await seedApproval('forged-basis-reference');
    const sink = createSimulatedPlatformWritePort('SIMULATED');
    await expect(
      runPlatformWriteAttempt(
        prisma,
        { approvals, sink, globalTransportEnabled: true, authorizationValid: true },
        attemptInput(approvalId),
      ),
    ).rejects.toThrowError(PlatformWriteLedgerError);
    expect(sink.callCount()).toBe(0);
    expect(await sideEffects()).toEqual({ attempts: 0, consumed: 0 });
  }, 60_000);

  it('09 审批跨动作冒用（commission.charge 审批用于 platform.write）→ T1 拒绝', async () => {
    registerEligibleAdapter();
    const approvalId = await seedApproval(DIGEST, 'commission.charge', {
      recoveredAmount: '100.0000',
      currency: 'USD',
    });
    const sink = createSimulatedPlatformWritePort('SIMULATED');
    await expect(
      runPlatformWriteAttempt(
        prisma,
        { approvals, sink, globalTransportEnabled: true, authorizationValid: true },
        attemptInput(approvalId),
      ),
    ).rejects.toThrowError(PlatformWriteLedgerError);
    expect(await sideEffects()).toEqual({ attempts: 0, consumed: 0 });
  }, 60_000);

  it('10 H8 投递结果不可判定 → UNKNOWN_PROVIDER_RESPONSE；重试不新建链、不重发', async () => {
    registerEligibleAdapter();
    const approvalId = await seedApproval();
    const failingSink = {
      platform: PLATFORM,
      simulated: true as const,
      calls: 0,
      async submit() {
        this.calls += 1;
        throw new Error('socket hang up');
      },
    };
    const deps = { approvals, sink: failingSink, globalTransportEnabled: true, authorizationValid: true };

    const first = await runPlatformWriteAttempt(prisma, deps, attemptInput(approvalId));
    expect(first.status).toBe('UNKNOWN_PROVIDER_RESPONSE');
    expect(first.sinkCalls).toBe(1);
    const row = await prisma.platformWriteAttempt.findFirstOrThrow({ where: { organizationId: ORG } });
    expect(row.status).toBe('MANUAL_REVIEW');
    expect(row.errorCode).toBe('UNKNOWN_PROVIDER_RESPONSE');

    // 重试同一负载：收敛到既有链，绝不重发写请求
    const retry = await runPlatformWriteAttempt(prisma, deps, attemptInput(approvalId));
    expect(retry.sinkCalls).toBe(0);
    expect(retry.attemptId).toBe(first.attemptId);
    expect(failingSink.calls).toBe(1);
    expect(await sideEffects()).toEqual({ attempts: 1, consumed: 1 });
  }, 60_000);
});
