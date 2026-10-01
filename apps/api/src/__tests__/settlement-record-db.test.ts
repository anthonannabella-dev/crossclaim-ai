/**
 * R46 S2 —— Settlement record / ingest 受保护写路径（真实 PostgreSQL）
 * 依据：MSG-20261002-55（S2 AUTHORIZED）。断言：happy / duplicate / digest 自证 / 跨租户 /
 * 未授权 / 并发同 receipt / 回滚零部分状态 / 不产生 Fee·Invoice·Payment·Ledger。
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hashPassword } from '../services/auth';
import {
  recordSettlement,
  SettlementRecordError,
  type SettlementRecordDeps,
} from '../services/settlement/record-settlement';
import { computeReceiptSnapshotDigest } from '../services/settlement/receipt-snapshot';

const prisma = new PrismaClient();
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'r46-s2-pass-1';
const ALLOW = new Set<string>();

const uuid = (): string => randomUUID();
const hex64 = (): string => (randomUUID() + randomUUID()).replace(/-/g, '').slice(0, 64);
const RUN = (): string => randomUUID().slice(0, 8);

let ORG_A = '';
let ORG_B = '';
let claimA = '';
let claimB = '';
let evidenceA = '';
let evidenceB = '';
let actor = '';
let actorInactive = '';

const deps: SettlementRecordDeps = {
  prisma,
  verifyApproval: async (request) => ALLOW.has(request.approvalId),
  assertActiveMembership: async (organizationId, userId) => {
    const row = await prisma.membership.findFirst({
      where: { organizationId, userId, isActive: true },
      select: { id: true },
    });
    if (!row) throw new SettlementRecordError('APPROVAL_REQUIRED', 'no ACTIVE membership');
  },
};

async function seedOrg(suffix: string): Promise<{ organizationId: string; userId: string; inactiveUserId: string }> {
  const id = uuid();
  await prisma.organization.create({ data: { id, name: 'R46 S2 ' + suffix, slug: `r46-s2-${suffix}-${RUN()}` } });
  const mk = async (label: string, active: boolean) => {
    const user = await prisma.user.create({
      data: {
        email: `r46-s2-${suffix}-${label}-${RUN()}@example.com`,
        passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
        displayName: label,
        status: 'ACTIVE',
        emailVerified: true,
      },
    });
    await prisma.membership.create({
      data: { organizationId: id, userId: user.id, role: 'OWNER', isActive: active },
    });
    return user.id;
  };
  return { organizationId: id, userId: await mk('owner', true), inactiveUserId: await mk('inactive', false) };
}

beforeAll(async () => {
  const a = await seedOrg('a');
  ORG_A = a.organizationId;
  actor = a.userId;
  actorInactive = a.inactiveUserId;
  const b = await seedOrg('b');
  ORG_B = b.organizationId;

  claimA = (
    await prisma.claimItem.create({
      data: {
        organizationId: ORG_A,
        platformType: 'AMAZON',
        claimType: 'FBA_REIMBURSEMENT',
        occurredAt: new Date('2026-08-01T00:00:00.000Z'),
        normalizerVersion: 'v1',
      },
      select: { id: true },
    })
  ).id;

  claimB = (
    await prisma.claimItem.create({
      data: {
        organizationId: ORG_B,
        platformType: 'AMAZON',
        claimType: 'FBA_REIMBURSEMENT',
        occurredAt: new Date('2026-08-01T00:00:00.000Z'),
        normalizerVersion: 'v1',
      },
      select: { id: true },
    })
  ).id;

  evidenceA = (
    await prisma.evidenceArtifact.create({
      data: { organizationId: ORG_A, kind: 'OTHER', title: 'bank statement A' },
      select: { id: true },
    })
  ).id;

  evidenceB = (
    await prisma.evidenceArtifact.create({
      data: { organizationId: ORG_B, kind: 'OTHER', title: 'bank statement B' },
      select: { id: true },
    })
  ).id;
});

beforeEach(() => {
  ALLOW.clear();
});

afterAll(async () => {
  await prisma.$disconnect();
});

function input(overrides: Record<string, unknown> = {}) {
  const approvalId = uuid();
  ALLOW.add(approvalId);
  return {
    organizationId: ORG_A,
    actorUserId: actor,
    approvalId,
    claimItemId: claimA,
    linkageBasisKind: 'CLAIM_ITEM_DIRECT' as const,
    externalIdentityKind: 'BANK_TRANSACTION' as const,
    externalIdentityValueHash: hex64(),
    externalIdentityVersion: 'v1',
    amount: '100.0000',
    currency: 'USD',
    receivedAt: '2026-09-30T01:00:00.000Z',
    sourceKind: 'BANK_STATEMENT' as const,
    evidenceReferences: [{ evidenceArtifactId: evidenceA, digest: hex64(), kind: 'BANK_STATEMENT' }],
    ...overrides,
  };
}

async function counts() {
  const [settlements, snapshots, fees, invoices, payments, ledger] = await Promise.all([
    prisma.settlement.count({ where: { organizationId: ORG_A } }),
    prisma.settlementReceiptSnapshot.count({ where: { organizationId: ORG_A } }),
    prisma.feeCalculation.count({ where: { organizationId: ORG_A } }),
    prisma.billingInvoice.count({ where: { organizationId: ORG_A } }),
    prisma.payment.count({ where: { organizationId: ORG_A } }),
    prisma.recoveryLedgerEntry.count({ where: { organizationId: ORG_A } }),
  ]);
  return { settlements, snapshots, fees, invoices, payments, ledger };
}

describe('R46 S2 settlement.record 受保护写路径（真实 PostgreSQL）', () => {
  it('happy path：snapshot + Settlement + audit + approval 消费 原子落库，且不产生资金域副作用', async () => {
    const before = await counts();
    const payload = input();
    const result = await recordSettlement(deps, payload);
    expect(result.status).toBe('CREATED');
    expect(result.snapshotDigest).toBe(computeReceiptSnapshotDigest(payload as never));

    const settlement = await prisma.settlement.findFirstOrThrow({ where: { id: result.settlementId } });
    expect(settlement.status).toBe('RECEIVED');
    expect(settlement.receiptSnapshotId).toBe(result.receiptSnapshotId);
    expect(Number(settlement.amount)).toBe(100);
    expect(settlement.claimItemId).toBe(claimA);

    const snapshot = await prisma.settlementReceiptSnapshot.findFirstOrThrow({
      where: { id: result.receiptSnapshotId },
    });
    expect(snapshot.snapshotDigest).toBe(result.snapshotDigest);

    const consumed = await prisma.auditLog.findFirst({
      where: { id: 'settlement-approval-' + payload.approvalId },
    });
    expect(consumed).not.toBeNull();

    const after = await counts();
    expect(after).toEqual({ ...before, settlements: before.settlements + 1, snapshots: before.snapshots + 1 });
    expect(after.fees).toBe(0);
    expect(after.invoices).toBe(0);
    expect(after.payments).toBe(0);
    expect(after.ledger).toBe(0);
  });

  it('duplicate ingest：同一到账完全重放 → REUSED，仍只有 1 条 Settlement / snapshot', async () => {
    const payload = input();
    const first = await recordSettlement(deps, payload);
    const before = await counts();
    const second = await recordSettlement(deps, payload);
    expect(second.status).toBe('REUSED');
    expect(second.settlementId).toBe(first.settlementId);
    expect(await counts()).toEqual(before);
  });

  it('same identity + 不同不可变事实 → EVENT_IDENTITY_CONFLICT，零新增', async () => {
    const payload = input();
    await recordSettlement(deps, payload);
    const before = await counts();
    await expect(
      ((): Promise<never> => { const approvalId2 = uuid(); ALLOW.add(approvalId2); return recordSettlement(deps, { ...payload, amount: '200.0000', approvalId: approvalId2 } as never) as Promise<never>; })(),
    ).rejects.toMatchObject({ code: 'EVENT_IDENTITY_CONFLICT' });
    expect(await counts()).toEqual(before);
  });

  it('客户端自证 digest / 派生字段 → fail-closed，零写入', async () => {
    const before = await counts();
    await expect(
      recordSettlement(deps, { ...input(), clientSnapshotDigest: hex64() } as never),
    ).rejects.toMatchObject({ code: 'CLIENT_DERIVED_FIELD_NOT_TRUSTED' });
    await expect(
      recordSettlement(deps, { ...input(), clientDerivedFields: { amount: '1.0000' } } as never),
    ).rejects.toMatchObject({ code: 'CLIENT_DERIVED_FIELD_NOT_TRUSTED' });
    await expect(
      recordSettlement(deps, { ...input(), sourceProjectionId: uuid() } as never),
    ).rejects.toMatchObject({ code: 'PROJECTION_CANNOT_CREATE_SETTLEMENT' });
    expect(await counts()).toEqual(before);
  });

  it('跨租户 claimItem / evidence → 拒绝，零写入', async () => {
    const before = await counts();
    await expect(
      recordSettlement(deps, { ...input(), claimItemId: claimB } as never),
    ).rejects.toMatchObject({ code: 'CROSS_TENANT_REFERENCE' });
    await expect(
      recordSettlement(deps, {
        ...input(),
        evidenceReferences: [{ evidenceArtifactId: evidenceB, digest: hex64(), kind: 'BANK_STATEMENT' }],
      } as never),
    ).rejects.toMatchObject({ code: 'CROSS_TENANT_REFERENCE' });
    expect(await counts()).toEqual(before);
  });

  it('未授权（approval 未通过）与 inactive membership → 零写入', async () => {
    const before = await counts();
    const approvalId = uuid();
    await expect(
      recordSettlement(deps, { ...input(), approvalId } as never),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });

    ALLOW.add(uuid());
    await expect(
      recordSettlement(deps, { ...input(), actorUserId: actorInactive } as never),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(await counts()).toEqual(before);
  });

  it('approval 已被消费（唯一冲突）→ APPROVAL_ALREADY_CONSUMED，整体回滚', async () => {
    const payload = input();
    await prisma.auditLog.create({
      data: {
        id: 'settlement-approval-' + payload.approvalId,
        organizationId: ORG_A,
        actorType: 'USER',
        actorUserId: actor,
        action: 'settlement.record.approval_consumed',
        entityType: 'Approval',
        entityId: payload.approvalId,
      },
    });
    const before = await counts();
    await expect(recordSettlement(deps, payload as never)).rejects.toMatchObject({
      code: 'APPROVAL_ALREADY_CONSUMED',
    });
    expect(await counts()).toEqual(before);
  });

  it('concurrent ingest：同 receipt 并发 → 恰好 1 条 Settlement，另一路幂等复用', async () => {
    const payload = input();
    const before = await counts();
    const [r1, r2] = await Promise.allSettled([
      recordSettlement(deps, payload as never),
      recordSettlement(deps, { ...payload } as never),
    ]);
    const ok = [r1, r2].filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<
      Awaited<ReturnType<typeof recordSettlement>>
    >[];
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const after = await counts();
    expect(after.settlements).toBe(before.settlements + 1);
    expect(after.snapshots).toBe(before.snapshots + 1);
    const ids = new Set(ok.map((r) => r.value.settlementId));
    expect(ids.size).toBe(1);
  });

  it('evidence 不存在 → 拒绝且零部分状态', async () => {
    const before = await counts();
    await expect(
      recordSettlement(deps, {
        ...input(),
        evidenceReferences: [{ evidenceArtifactId: uuid(), digest: hex64(), kind: 'BANK_STATEMENT' }],
      } as never),
    ).rejects.toMatchObject({ code: 'EVIDENCE_NOT_FOUND' });
    expect(await counts()).toEqual(before);
  });
});

describe('R46 S2 approval 绑定漂移 与 snapshot 不可漂移（DB 级）', () => {
  it('approval 绑定的是另一组到账事实（digest 漂移）→ 拒绝，零写入', async () => {
    const payload = input();
    const staleDigest = computeReceiptSnapshotDigest({ ...payload, amount: '999.0000' } as never);
    const strictDeps: SettlementRecordDeps = {
      prisma,
      assertActiveMembership: deps.assertActiveMembership,
      verifyApproval: async (request) => request.boundExtra.receiptSnapshotDigest === staleDigest,
    };
    const before = await counts();
    await expect(recordSettlement(strictDeps, payload as never)).rejects.toMatchObject({
      code: 'APPROVAL_REQUIRED',
    });
    expect(await counts()).toEqual(before);
  });

  it('Settlement.receiptSnapshotId 与 Snapshot 行创建后不可改（DB 触发器）', async () => {
    const result = await recordSettlement(deps, input() as never);
    const other = await recordSettlement(deps, input() as never);

    await expect(
      prisma.settlement.update({
        where: { id: result.settlementId },
        data: { receiptSnapshotId: other.receiptSnapshotId },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.settlementReceiptSnapshot.update({
        where: { id: result.receiptSnapshotId },
        data: { snapshotDigest: 'f'.repeat(64) },
      }),
    ).rejects.toThrow();

    const row = await prisma.settlement.findFirstOrThrow({ where: { id: result.settlementId } });
    expect(row.receiptSnapshotId).toBe(result.receiptSnapshotId);
  });
});
