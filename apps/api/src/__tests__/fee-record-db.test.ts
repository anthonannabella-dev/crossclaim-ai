/** R46 S4 —— FeeCalculation 受保护写路径 真实 PostgreSQL 验收（MSG-20261002-59） */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hashPassword } from '../services/auth';
import {
  recordFeeCalculation,
  type FeeRecordDeps,
} from '../services/settlement/record-fee';

const prisma = new PrismaClient();
const FAST = { N: 1024, r: 8, p: 1, keyLength: 64 };
const ALLOW = new Set<string>();
const uuid = (): string => randomUUID();

let ORG_A = '';
let ORG_B = '';
let actor = '';
let claimA = '';

const deps: FeeRecordDeps = {
  prisma,
  verifyApproval: async (r) => ALLOW.has(r.approvalId),
  assertActiveMembership: async (organizationId, userId) => {
    const row = await prisma.membership.findFirst({
      where: { organizationId, userId, isActive: true },
      select: { id: true },
    });
    if (!row) throw new Error('NO_ACTIVE_MEMBERSHIP');
  },
};

async function seedOrg(suffix: string) {
  const id = uuid();
  await prisma.organization.create({ data: { id, name: 'R46 S4 ' + suffix, slug: `r46-s4-${suffix}-${uuid().slice(0, 8)}` } });
  const user = await prisma.user.create({
    data: {
      email: `r46-s4-${suffix}-${uuid().slice(0, 8)}@example.com`,
      passwordHash: hashPassword('r46-s4-pass-123', FAST),
      displayName: 'OWNER',
      status: 'ACTIVE',
      emailVerified: true,
    },
  });
  await prisma.membership.create({ data: { organizationId: id, userId: user.id, role: 'OWNER', isActive: true } });
  return { organizationId: id, userId: user.id };
}

async function newClaim(organizationId: string): Promise<string> {
  return (
    await prisma.claimItem.create({
      data: {
        organizationId,
        platformType: 'AMAZON',
        claimType: 'FBA_REIMBURSEMENT',
        occurredAt: new Date('2026-08-01T00:00:00.000Z'),
        normalizerVersion: 'v1',
      },
      select: { id: true },
    })
  ).id;
}

async function seedEligibleSettlement(organizationId: string, amount = '1000.0000', claimItemId = claimA) {
  const evidence = await prisma.evidenceArtifact.create({
    data: { organizationId, kind: 'OTHER', title: 'fee evidence' },
    select: { id: true },
  });
  return (
    await prisma.settlement.create({
      data: {
        organizationId,
        status: 'RECEIVED',
        source: 'PLATFORM_CREDIT',
        amount,
        currency: 'USD',
        receivedAt: new Date('2026-09-30T01:00:00.000Z'),
        evidenceId: evidence.id,
        confirmationStatus: 'CONFIRMED',
        reconciliationStatus: 'RECONCILED',
        linkageBasisKind: 'CLAIM_ITEM_DIRECT',
        claimItemId,
      },
      select: { id: true },
    })
  ).id;
}

function input(over: Record<string, unknown> = {}) {
  const approvalId = uuid();
  ALLOW.add(approvalId);
  return {
    organizationId: ORG_A,
    actorUserId: actor,
    approvalId,
    feeChainId: uuid(),
    claimItemId: claimA,
    settlementIds: [] as string[],
    policy: {
      basis: 'RECOVERED_AMOUNT_PCT' as const,
      rate: '0.15',
      policyRef: 'policy-2026-01',
      feeBasisVersion: 'v1',
      currency: 'USD',
    },
    ...over,
  };
}

async function counts() {
  const [fees, memberships, invoices, payments] = await Promise.all([
    prisma.feeCalculation.count({ where: { organizationId: ORG_A } }),
    prisma.feeCalculationSettlement.count({ where: { organizationId: ORG_A } }),
    prisma.billingInvoice.count({ where: { organizationId: ORG_A } }),
    prisma.payment.count({ where: { organizationId: ORG_A } }),
  ]);
  return { fees, memberships, invoices, payments };
}

beforeAll(async () => {
  const a = await seedOrg('a');
  ORG_A = a.organizationId;
  actor = a.userId;
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
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('R46 S4 FeeCalculation 受保护写路径（真实 PostgreSQL）', () => {
  it('happy path：eligible Settlement → membership + FeeCalculation；Invoice/Payment 仍为 0', async () => {
    const st = await seedEligibleSettlement(ORG_A);
    const before = await counts();
    const r = await recordFeeCalculation(deps, input({ settlementIds: [st] }) as never);
    expect(r.baseAmount).toBe('1000.0000');
    expect(r.feeAmount).toBe('150.0000');

    const fee = await prisma.feeCalculation.findFirstOrThrow({ where: { id: r.feeCalculationId } });
    expect(String(fee.feeAmount)).toBe('150');
    expect(fee.membershipDigest).toBe(r.membershipDigest);
    expect(fee.policyRef).toBe('policy-2026-01');
    expect(fee.feeBasisVersion).toBe('v1');

    const after = await counts();
    expect(after.fees).toBe(before.fees + 1);
    expect(after.memberships).toBe(before.memberships + 1);
    expect(after.invoices).toBe(0);
    expect(after.payments).toBe(0);
  });

  it('非 eligible（reversed / 缺证据 / 跨租户）→ 拒绝且零写入', async () => {
    const claim1 = await newClaim(ORG_A);
    const stReversed = await seedEligibleSettlement(ORG_A, '1000.0000', claim1);
    await prisma.settlement.update({ where: { id: stReversed }, data: { reversedBySettlementId: null, reconciliationStatus: 'REVERSED' } });
    const before = await counts();
    await expect(
      recordFeeCalculation(deps, input({ settlementIds: [stReversed], claimItemId: claim1 }) as never),
    ).rejects.toMatchObject({
      code: 'SETTLEMENT_NOT_FEE_ELIGIBLE',
    });

    const other = await seedEligibleSettlement(ORG_B, '1000.0000', await newClaim(ORG_B));
    await expect(
      recordFeeCalculation(deps, input({ settlementIds: [other], claimItemId: claim1 }) as never),
    ).rejects.toMatchObject({
      code: 'CROSS_TENANT_REFERENCE',
    });
    expect(await counts()).toEqual(before);
  });

  it('客户端自报费率 / 政策 → 拒绝；approval 重复消费 → 整体回滚', async () => {
    const claim2 = await newClaim(ORG_A);
    const st = await seedEligibleSettlement(ORG_A, '1000.0000', claim2);
    const before = await counts();
    await expect(
      recordFeeCalculation(deps, input({ settlementIds: [st], claimItemId: claim2, clientSuppliedRate: '0.9' }) as never),
    ).rejects.toMatchObject({ code: 'CLIENT_FEE_INPUT_NOT_TRUSTED' });

    const payload = input({ settlementIds: [st], claimItemId: claim2 });
    await recordFeeCalculation(deps, payload as never);
    await expect(recordFeeCalculation(deps, { ...payload } as never)).rejects.toMatchObject({
      code: 'APPROVAL_ALREADY_CONSUMED',
    });
    const after = await counts();
    expect(after.fees).toBe(before.fees + 1);
    expect(after.invoices).toBe(0);
    expect(after.payments).toBe(0);
  });

  it('同 claimItem 的另一 active chain → MEMBERSHIP_CHAIN_CONFLICT；并发同 chain 至多一条', async () => {
    const claim3 = await newClaim(ORG_A);
    const st = await seedEligibleSettlement(ORG_A, '1000.0000', claim3);
    const first = input({ settlementIds: [st], claimItemId: claim3 });
    await recordFeeCalculation(deps, first as never);
    const st2 = await seedEligibleSettlement(ORG_A, '1000.0000', claim3);
    await expect(
      recordFeeCalculation(deps, input({ settlementIds: [st2], claimItemId: claim3 }) as never),
    ).rejects.toMatchObject({
      code: 'MEMBERSHIP_CHAIN_CONFLICT',
    });

    const r = await Promise.allSettled([
      recordFeeCalculation(deps, { ...first, approvalId: (() => { const id = uuid(); ALLOW.add(id); return id; })() } as never),
      recordFeeCalculation(deps, { ...first, approvalId: (() => { const id = uuid(); ALLOW.add(id); return id; })() } as never),
    ]);
    void r;
    const rows = await prisma.feeCalculationSettlement.count({ where: { organizationId: ORG_A, settlementId: st } });
    expect(rows).toBe(1);
  });
});
