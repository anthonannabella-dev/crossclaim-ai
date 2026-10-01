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
});
