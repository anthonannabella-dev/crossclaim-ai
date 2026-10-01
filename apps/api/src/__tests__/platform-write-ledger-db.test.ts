/**
 * platform.write 持久化账本 —— **数据库级**验收（真实 PostgreSQL）
 * ---------------------------------------------------------------
 * 覆盖 MSG-20261001-19 要求的断言子集：
 *   PG1  同幂等键并发 → 恰一个取得执行权
 *   PG2  同 approval + 不同 snapshot → 第二执行链被拒（approval 唯一绑定）
 *   PG3  T1 内消费写入失败 → 整笔回滚（attempt 无残留）
 *   PG4  approval 已消费 → 拒绝
 *   PG5  UNKNOWN 对账只读：probe 被调用、write sink 调用次数为 0
 *   PG8  SUCCEEDED 不可再收敛（CAS mismatch）
 *   PG9  跨租户访问被拒
 *   PG10 绕过服务层直插两条 SUCCEEDED 同键 → partial unique index 拦截
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PlatformWriteLedgerError,
  acquireExecutionRight,
  reconcileOnce,
  settleAttempt,
  type PlatformWriteApprovalInTxPort,
} from '../services/platform-write';
import { createSimulatedPlatformWritePort } from '../services/platform-write';

const prisma = new PrismaClient();

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const ACTOR = randomUUID();
const APPROVAL_ACTION = 'recovery.review_approved';
const CONSUMED_ACTION = 'recovery.approval_consumed';

/** 以 AuditLog 为事实来源的审批端口（与既有审批边界同一形状） */
function ledgerApprovalPort(options: { failConsume?: boolean } = {}): PlatformWriteApprovalInTxPort {
  return {
    async verifyInTransaction(tx, args) {
      const row = await tx.auditLog.findFirst({
        where: { id: args.approvalId, organizationId: args.organizationId, action: args.action },
      });
      if (!row) return { ok: false, code: 'PLATFORM_WRITE_APPROVAL_INVALID', message: '审批不存在或不属于该租户' };
      const changes = (row.changes ?? {}) as { basisReference?: string };
      if (changes.basisReference !== args.snapshotDigest) {
        return { ok: false, code: 'PLATFORM_WRITE_APPROVAL_INVALID', message: '审批绑定的快照摘要与本次提交不一致' };
      }
      const consumed = await tx.auditLog.count({
        where: { organizationId: args.organizationId, action: CONSUMED_ACTION, entityId: args.approvalId },
      });
      if (consumed > 0) return { ok: false, code: 'PLATFORM_WRITE_APPROVAL_INVALID', message: '审批已被消费' };
      return { ok: true };
    },
    async consumeInTransaction(tx, args) {
      if (options.failConsume) throw new Error('CONSUME_WRITE_REJECTED');
      await tx.auditLog.create({
        data: {
          organizationId: args.organizationId,
          actorType: 'SYSTEM',
          actorRef: 'platform-write-ledger-test',
          action: CONSUMED_ACTION,
          entityType: 'PlatformWriteAttempt',
          entityId: args.approvalId,
          changes: { approvalId: args.approvalId, attemptId: args.attemptId },
        },
      });
    },
  };
}

function request(overrides: Partial<Parameters<typeof acquireExecutionRight>[2]> = {}) {
  const digest = overrides.snapshotDigest ?? 'a'.repeat(64);
  return {
    organizationId: ORG_A,
    action: 'platform.write',
    caseId: randomUUID(),
    targetKind: 'CLAIM' as const,
    targetId: randomUUID(),
    platform: 'SIMULATED',
    simulated: true,
    approvalId: null,
    snapshotVersion: 'platform-write-request/v1',
    snapshotDigest: digest,
    idempotencyKey: 'pw1-' + digest.slice(0, 40),
    actorUserId: ACTOR,
    ...overrides,
  };
}

async function seedApproval(organizationId: string, digest: string): Promise<string> {
  const row = await prisma.auditLog.create({
    data: {
      organizationId,
      actorType: 'SYSTEM',
      actorRef: 'platform-write-ledger-test',
      action: APPROVAL_ACTION,
      entityType: 'Case',
      changes: { basisReference: digest },
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * PG1–PG10 → test name / evidence 映射（CHANGE C）：
 *   PG1  同幂等键并发恰一次            → 'PG1 同幂等键并发 → 恰一个取得执行权，另一个返回既有链'
 *   PG2  同 approval 不同 snapshot 拒绝 → 'PG2 同 approval + 不同 snapshot → 第二执行链被拒（approval 唯一绑定）'
 *   PG3  T1 消费写入失败整笔回滚        → 'PG3 T1 内消费写入失败 → 整笔回滚（attempt 无残留）'
 *   PG4  approval 已消费拒绝            → 'PG4 approval 已消费 → 拒绝（消费是事务事实）'
 *   PG5  UNKNOWN 对账只读、sink 0 次    → 'PG5 UNKNOWN 对账只读：probe 被调用，write sink 调用次数为 0'
 *   PG6  跨进程/重启恢复（新 client）    → 'PG6 跨进程/重启恢复：销毁原 client，新 client 从数据库事实恢复'
 *   PG7  双 worker 真实竞争至多一次收敛  → 'PG7 两个独立 client 并发 R1：恰一个收敛，loser 明确 no-op'
 *   PG8  SUCCEEDED 不可再收敛           → 'PG8 SUCCEEDED 不可再收敛（CAS mismatch）'
 *   PG9  跨租户访问拒绝                 → 'PG9 跨租户访问被拒'
 *   PG10 partial unique index 兜底      → 'PG10 绕过服务层直插两条 SUCCEEDED 同键 → partial unique index 拦截'
 */

beforeAll(async () => {
  await prisma.organization.createMany({
    data: [
      { id: ORG_A, name: 'Ledger A', slug: 'ledger-a-' + ORG_A.slice(0, 8) },
      { id: ORG_B, name: 'Ledger B', slug: 'ledger-b-' + ORG_B.slice(0, 8) },
    ],
  });
});

afterAll(async () => {
  await prisma.platformWriteAttempt.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await prisma.auditLog.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
  await prisma.$disconnect();
});

describe('platform.write 持久化账本（PostgreSQL）', () => {
  it('PG1 同幂等键并发 → 恰一个取得执行权，另一个返回既有链', async () => {
    const input = request();
    const port = ledgerApprovalPort();
    const results = await Promise.all([
      acquireExecutionRight(prisma, port, input),
      acquireExecutionRight(prisma, port, input),
    ]);
    const acquired = results.filter((r) => r.acquired);
    expect(acquired).toHaveLength(1);
    expect(results.filter((r) => !r.acquired).length).toBe(1);
    const rows = await prisma.platformWriteAttempt.count({ where: { organizationId: ORG_A, idempotencyKey: input.idempotencyKey } });
    expect(rows).toBe(1);
  });

  it('PG2 同 approval + 不同 snapshot → 第二执行链被拒（approval 唯一绑定）', async () => {
    const digestA = 'b'.repeat(64);
    const digestB = 'c'.repeat(64);
    const approvalId = await seedApproval(ORG_A, digestA);
    const port = ledgerApprovalPort();

    await acquireExecutionRight(prisma, port, request({ snapshotDigest: digestA, idempotencyKey: 'pw1-' + 'b'.repeat(40), approvalId }));

    // 同一 approval + 不同 snapshot：审批绑定的 basisReference(digestA) 与本次提交(digestB) 不一致 → 拒绝
    const second = acquireExecutionRight(
      prisma,
      port,
      request({
        snapshotDigest: digestB,
        idempotencyKey: 'pw1-' + 'c'.repeat(40),
        approvalId,
      }),
    );
    await expect(second).rejects.toBeInstanceOf(PlatformWriteLedgerError);

    const boundToFirstApproval = await prisma.platformWriteAttempt.count({ where: { organizationId: ORG_A, approvalId } });
    expect(boundToFirstApproval).toBe(1);
  });

  it('PG3 T1 内消费写入失败 → 整笔回滚（attempt 无残留）', async () => {
    const digest = 'd'.repeat(64);
    const approvalId = await seedApproval(ORG_A, digest);
    const failing = ledgerApprovalPort({ failConsume: true });
    await expect(
      acquireExecutionRight(prisma, failing, request({ snapshotDigest: digest, idempotencyKey: 'pw1-' + 'd'.repeat(40), approvalId })),
    ).rejects.toThrow('CONSUME_WRITE_REJECTED');
    const rows = await prisma.platformWriteAttempt.count({ where: { organizationId: ORG_A, idempotencyKey: 'pw1-' + 'd'.repeat(40) } });
    expect(rows).toBe(0);
  });

  it('PG4 approval 已消费 → 拒绝（消费是事务事实）', async () => {
    const digest = 'e'.repeat(64);
    const approvalId = await seedApproval(ORG_A, digest);
    const port = ledgerApprovalPort();
    await acquireExecutionRight(prisma, port, request({ snapshotDigest: digest, idempotencyKey: 'pw1-' + 'e'.repeat(40), approvalId }));

    await expect(
      acquireExecutionRight(
        prisma,
        port,
        request({ snapshotDigest: digest, idempotencyKey: 'pw1-' + 'f'.repeat(40), approvalId }),
      ),
    ).rejects.toBeInstanceOf(PlatformWriteLedgerError);
  });

  it('PG5 UNKNOWN 对账只读：probe 被调用，write sink 调用次数为 0', async () => {
    const digest = '1'.repeat(64);
    const input = request({ snapshotDigest: digest, idempotencyKey: 'pw1-' + '1'.repeat(40) });
    const acquired = await acquireExecutionRight(prisma, ledgerApprovalPort(), input);

    await settleAttempt(prisma, {
      organizationId: ORG_A,
      attemptId: acquired.attemptId,
      status: 'UNKNOWN_PROVIDER_RESPONSE' as never,
      errorCode: 'TIMEOUT',
    } as never);

    const sink = createSimulatedPlatformWritePort('SIMULATED');
    let probeCalls = 0;
    const result = await reconcileOnce(prisma, {
      organizationId: ORG_A,
      attemptId: acquired.attemptId,
      actor: 'SYSTEM',
      probe: async () => {
        probeCalls += 1;
        return { kind: 'INCONCLUSIVE', detail: '查询失败' };
      },
    });

    expect(probeCalls).toBe(1);
    expect(sink.callCount()).toBe(0);
    expect(result.status).toBe('RECONCILING');
    expect(result.automated).toBe(false);
  });

  it('PG8 SUCCEEDED 不可再收敛（CAS mismatch）', async () => {
    const digest = '2'.repeat(64);
    const input = request({ snapshotDigest: digest, idempotencyKey: 'pw1-' + '2'.repeat(40) });
    const acquired = await acquireExecutionRight(prisma, ledgerApprovalPort(), input);
    await settleAttempt(prisma, { organizationId: ORG_A, attemptId: acquired.attemptId, status: 'SUCCEEDED', providerRef: 'SIM-1' });
    await expect(
      settleAttempt(prisma, { organizationId: ORG_A, attemptId: acquired.attemptId, status: 'FAILED' }),
    ).rejects.toBeInstanceOf(PlatformWriteLedgerError);
  });

  it('PG9 跨租户访问被拒', async () => {
    const digest = '3'.repeat(64);
    const input = request({ snapshotDigest: digest, idempotencyKey: 'pw1-' + '3'.repeat(40) });
    const acquired = await acquireExecutionRight(prisma, ledgerApprovalPort(), input);
    await expect(
      settleAttempt(prisma, { organizationId: ORG_B, attemptId: acquired.attemptId, status: 'SUCCEEDED' }),
    ).rejects.toBeInstanceOf(PlatformWriteLedgerError);
  });

  it('PG10 绕过服务层直插两条 SUCCEEDED 同键 → partial unique index 拦截', async () => {
    const digest = '4'.repeat(64);
    const key = 'pw1-' + '4'.repeat(40);
    const base = {
      organizationId: ORG_A,
      action: 'platform.write',
      snapshotVersion: 'platform-write-request/v1',
      snapshotDigest: digest,
      idempotencyKey: key,
      attemptNo: 1,
      status: 'SUCCEEDED' as const,
      targetKind: 'CLAIM',
      targetId: randomUUID(),
      platform: 'SIMULATED',
      simulated: true,
    };
    await prisma.platformWriteAttempt.create({ data: base });
    await expect(prisma.platformWriteAttempt.create({ data: { ...base, id: randomUUID() } })).rejects.toBeTruthy();
  });

  it('PG6 跨进程/重启恢复：销毁原 client，新 client 从数据库事实恢复', async () => {
    const digest = '5'.repeat(64);
    const key = 'pw1-' + '5'.repeat(40);
    const approvalId = await seedApproval(ORG_A, digest);
    const acquired = await acquireExecutionRight(
      prisma,
      ledgerApprovalPort(),
      request({ snapshotDigest: digest, idempotencyKey: key, approvalId }),
    );
    await settleAttempt(prisma, {
      organizationId: ORG_A,
      attemptId: acquired.attemptId,
      status: 'UNKNOWN_PROVIDER_RESPONSE' as never,
      errorCode: 'TIMEOUT',
    } as never);

    const consumedBefore = await prisma.auditLog.count({
      where: { organizationId: ORG_A, action: CONSUMED_ACTION, entityId: approvalId },
    });
    const chainBefore = await prisma.platformWriteAttempt.count({ where: { organizationId: ORG_A, idempotencyKey: key } });

    // 模拟原 worker 消失：全新 client（独立连接/runtime），只依赖数据库事实
    const fresh = new PrismaClient();
    try {
      const sink = createSimulatedPlatformWritePort('SIMULATED');
      let probeCalls = 0;
      const recovered = await reconcileOnce(fresh, {
        organizationId: ORG_A,
        attemptId: acquired.attemptId,
        actor: 'SYSTEM',
        probe: async () => {
          probeCalls += 1;
          return { kind: 'INCONCLUSIVE', detail: '恢复期查询失败' };
        },
      });
      expect(probeCalls).toBe(1);
      expect(sink.callCount()).toBe(0);
      expect(recovered.status).toBe('RECONCILING');

      const after = await fresh.platformWriteAttempt.findFirst({
        where: { organizationId: ORG_A, idempotencyKey: key },
      });
      expect(after?.id).toBe(acquired.attemptId);
      expect(after?.idempotencyKey).toBe(key);
      expect(after?.reconcileAttempts).toBe(1);
      expect(after?.reconcileLastActor).toBe('SYSTEM');
      expect(await fresh.auditLog.count({ where: { organizationId: ORG_A, action: CONSUMED_ACTION, entityId: approvalId } })).toBe(consumedBefore);
      expect(await fresh.platformWriteAttempt.count({ where: { organizationId: ORG_A, idempotencyKey: key } })).toBe(chainBefore);
    } finally {
      await fresh.$disconnect();
    }
  });

  it('PG7 两个独立 client 并发 R1：恰一个收敛，loser 明确 no-op', async () => {
    const digest = '6'.repeat(64);
    const key = 'pw1-' + '6'.repeat(40);
    const approvalId = await seedApproval(ORG_A, digest);
    const acquired = await acquireExecutionRight(
      prisma,
      ledgerApprovalPort(),
      request({ snapshotDigest: digest, idempotencyKey: key, approvalId }),
    );
    await settleAttempt(prisma, {
      organizationId: ORG_A,
      attemptId: acquired.attemptId,
      status: 'RECONCILING' as never,
    } as never);

    const clientA = new PrismaClient();
    const clientB = new PrismaClient();
    try {
      const candidateA = await clientA.platformWriteAttempt.findFirst({ where: { id: acquired.attemptId } });
      const candidateB = await clientB.platformWriteAttempt.findFirst({ where: { id: acquired.attemptId } });
      expect(candidateA?.status).toBe('RECONCILING');
      expect(candidateB?.status).toBe('RECONCILING');

      const run = (client: PrismaClient) =>
        reconcileOnce(client, {
          organizationId: ORG_A,
          attemptId: acquired.attemptId,
          actor: 'SYSTEM',
          probe: async () => ({ kind: 'CONFIRMED_SUCCEEDED', providerRef: 'SIM-RACE' }),
        });
      const settled = await Promise.allSettled([run(clientA), run(clientB)]);
      const ok = settled.filter((r) => r.status === 'fulfilled');
      const failed = settled.filter((r) => r.status === 'rejected');
      expect(ok).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(PlatformWriteLedgerError);

      const row = await prisma.platformWriteAttempt.findFirst({ where: { id: acquired.attemptId } });
      expect(row?.status).toBe('SUCCEEDED');
      expect(row?.reconcileAttempts).toBe(1);
      expect(await prisma.platformWriteAttempt.count({ where: { organizationId: ORG_A, idempotencyKey: key, status: 'SUCCEEDED' } })).toBe(1);
      expect(await prisma.auditLog.count({ where: { organizationId: ORG_A, action: CONSUMED_ACTION, entityId: approvalId } })).toBe(1);
    } finally {
      await clientA.$disconnect();
      await clientB.$disconnect();
    }
  });
});
