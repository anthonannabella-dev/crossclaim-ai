// MSG-20260929-26 验收（真实 PostgreSQL）：Recovery Confirmation Schema Delta。
// 覆盖：跨租户拒绝、payoutRef 幂等、PARTIAL→RECONCILED、超额→DISPUTED、
//       冲回链（I7 原金额不可改 + 冲回后禁再登记到账）、历史 Settlement 默认双轴状态。

import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  linkReversal,
  readProjection,
  recordRecoveryConfirmation,
  recordRecoveryPayout,
} from '../services/recovery/recovery-confirmation';
import { createAuditWriter } from '../services/audit';
import { createPrismaAuditSink } from '../services/audit/prisma-sink';

const prisma = new PrismaClient();
const ORG = 'b5000000-0000-4000-8000-000000000001';
const ORG_B = 'b5000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-09-29T09:00:00Z');

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: 'recovery-confirmation-test-salt' });

let ownerId = '';
let settlementId = '';
let foreignSettlementId = '';

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "RecoveryPayout", "ClaimItemEvidence", "ClaimItem", "PaymentProcessingAttempt", "Payment", "PaymentEvent", "AuditLog", "BillingInvoice", "FeeCalculation", "RecoveryLedgerEntry", "Settlement", "Claim", "CaseEvidence", "EvidenceArtifact", "RecoveryRoute", "CaseOpportunity", "Case", "RecoveryOpportunity", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.createMany({
    data: [
      { id: ORG, name: '到账对账租户', slug: 'recon-org' },
      { id: ORG_B, name: '外部租户', slug: 'recon-org-b' },
    ],
  });
  const owner = await prisma.user.create({
    data: { email: 'recon-owner@example.com', displayName: '负责人', status: 'ACTIVE' },
  });
  ownerId = owner.id;
  await prisma.membership.createMany({
    data: [{ organizationId: ORG, userId: owner.id, role: 'OWNER', isActive: true }],
  });

  // 直接用“历史写法”创建 Settlement（不传新列）→ 验证默认值语义
  const settlement = await prisma.settlement.create({
    data: {
      organizationId: ORG,
      status: 'RECEIVED',
      source: 'OTHER',
      amount: new Prisma.Decimal('100.0000'),
      currency: 'USD',
      receivedAt: NOW,
    },
  });
  settlementId = settlement.id;

  const foreign = await prisma.settlement.create({
    data: {
      organizationId: ORG_B,
      status: 'RECEIVED',
      source: 'OTHER',
      amount: new Prisma.Decimal('50.0000'),
      currency: 'USD',
      receivedAt: NOW,
    },
  });
  foreignSettlementId = foreign.id;
});

const base = () => ({ organizationId: ORG, settlementId, actorUserId: ownerId, role: 'OWNER' }) as const;

const payout = (
  overrides: Partial<Parameters<typeof recordRecoveryPayout>[0]> = {},
): Promise<Awaited<ReturnType<typeof recordRecoveryPayout>>> =>
  recordRecoveryPayout(
    {
      ...base(),
      payoutRef: 'PY-1',
      amount: '40.0000',
      currency: 'USD',
      receivedAt: NOW,
      sourceType: 'PLATFORM_SETTLEMENT',
      ...overrides,
    },
    { prisma, audit, now: () => NOW },
  );

describe('MSG-26 · Recovery Confirmation（真实 PostgreSQL）', () => {
  it('01 历史 Settlement 的默认双轴状态 = CONFIRMED + NOT_STARTED', async () => {
    const row = await prisma.settlement.findUniqueOrThrow({ where: { id: settlementId } });
    expect(row.confirmationStatus).toBe('CONFIRMED');
    expect(row.reconciliationStatus).toBe('NOT_STARTED');
  });

  it('02 跨租户：不得对他租户的 Settlement 登记到账（I1）', async () => {
    await expect(
      payout({ settlementId: foreignSettlementId }),
    ).rejects.toThrowError(/不存在或不属于该租户/);
    expect(await prisma.recoveryPayout.count()).toBe(0);
  });

  it('03 部分到账：状态 PARTIAL，receivedAmount 为投影', async () => {
    const result = await payout();
    expect(result.created).toBe(true);
    expect(result.receivedAmount).toBe('40.0000');
    expect(result.confirmedAmount).toBe('100.0000');

    const row = await prisma.settlement.findUniqueOrThrow({ where: { id: settlementId } });
    expect(row.reconciliationStatus).toBe('PARTIAL');
    // 金额口径零改动：Settlement.amount 不被到账影响
    expect(row.amount.toFixed(4)).toBe('100.0000');
  });

  it('04 payoutRef 幂等：重复登记不重复累加（I6）', async () => {
    const first = await payout();
    const second = await payout();
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.payoutId).toBe(first.payoutId);
    expect(second.receivedAmount).toBe('40.0000');
    expect(await prisma.recoveryPayout.count()).toBe(1);
  });

  it('05 多期到账至全额 → RECONCILED', async () => {
    await payout({ payoutRef: 'PY-1', amount: '40.0000' });
    const second = await payout({ payoutRef: 'PY-2', amount: '60.0000' });
    expect(second.receivedAmount).toBe('100.0000');
    expect(second.reconciliationStatus).toBe('RECONCILED');
    const row = await prisma.settlement.findUniqueOrThrow({ where: { id: settlementId } });
    expect(row.reconciliationStatus).toBe('RECONCILED');
  });

  it('06 超额到账 → DISPUTED，且 Settlement.amount 不被自动放大（D3）', async () => {
    await payout({ payoutRef: 'PY-1', amount: '100.0000' });
    const extra = await payout({ payoutRef: 'PY-2', amount: '0.5000' });
    expect(extra.receivedAmount).toBe('100.5000');
    expect(extra.reconciliationStatus).toBe('DISPUTED');

    const row = await prisma.settlement.findUniqueOrThrow({ where: { id: settlementId } });
    expect(row.reconciliationStatus).toBe('DISPUTED');
    expect(row.amount.toFixed(4)).toBe('100.0000');
  });

  it('07 冲回链：原金额不可改，冲回后不得再登记到账（I7）', async () => {
    await payout({ payoutRef: 'PY-1', amount: '100.0000' });
    const reversal = await prisma.settlement.create({
      data: {
        organizationId: ORG,
        status: 'VOID',
        source: 'OTHER',
        amount: new Prisma.Decimal('-100.0000'),
        currency: 'USD',
        receivedAt: NOW,
      },
    });

    const linked = await linkReversal(
      { ...base(), reversalSettlementId: reversal.id },
      { prisma, audit, now: () => NOW },
    );
    expect(linked.reconciliationStatus).toBe('REVERSED');

    const row = await prisma.settlement.findUniqueOrThrow({ where: { id: settlementId } });
    expect(row.reversedBySettlementId).toBe(reversal.id);
    expect(row.reconciliationStatus).toBe('REVERSED');
    expect(row.amount.toFixed(4)).toBe('100.0000');

    await expect(payout({ payoutRef: 'PY-3', amount: '1.0000' })).rejects.toThrowError(/已冲回/);
  });

  it('08 业务确认（第一轴）与到账（第二轴）互不覆盖', async () => {
    const pending = await recordRecoveryConfirmation(
      { ...base(), confirmationStatus: 'PENDING_CONFIRMATION' },
      { prisma, audit, now: () => NOW },
    );
    expect(pending.confirmationStatus).toBe('PENDING_CONFIRMATION');

    const afterPayout = await payout({ payoutRef: 'PY-1', amount: '100.0000' });
    expect(afterPayout.reconciliationStatus).toBe('RECONCILED');

    const row = await prisma.settlement.findUniqueOrThrow({ where: { id: settlementId } });
    // 到账不改变确认轴
    expect(row.confirmationStatus).toBe('PENDING_CONFIRMATION');

    const confirmed = await recordRecoveryConfirmation(
      { ...base(), confirmationStatus: 'CONFIRMED' },
      { prisma, audit, now: () => NOW },
    );
    expect(confirmed.changed).toBe(true);
    const final = await prisma.settlement.findUniqueOrThrow({ where: { id: settlementId } });
    expect(final.confirmationStatus).toBe('CONFIRMED');
    expect(final.confirmedByUserId).toBe(ownerId);
    expect(final.confirmedAt).not.toBeNull();
    // 确认不改变到账轴
    expect(final.reconciliationStatus).toBe('RECONCILED');
  });

  it('09 投影读侧：payouts 明细可追溯，receivedAmount 不落库', async () => {
    await payout({ payoutRef: 'PY-1', amount: '25.0000' });
    await payout({ payoutRef: 'PY-2', amount: '35.0000' });
    const projection = await readProjection({ prisma, audit }, ORG, settlementId);
    expect(projection.receivedAmount).toBe('60.0000');
    expect(projection.payoutCount).toBe(2);
    expect(projection.payouts.map((row) => row.payoutRef)).toEqual(['PY-1', 'PY-2']);
    expect(projection.derivedReconciliationStatus).toBe('PARTIAL');
  });

  it('10 审计留痕：登记 / 幂等 / 对账变化 / 冲回全部可追溯', async () => {
    await payout({ payoutRef: 'PY-1', amount: '40.0000' });
    await payout({ payoutRef: 'PY-1', amount: '40.0000' });
    await payout({ payoutRef: 'PY-2', amount: '60.0000' });

    const actions = (
      await prisma.auditLog.findMany({ where: { organizationId: ORG }, orderBy: { createdAt: 'asc' } })
    ).map((row) => row.action);

    expect(actions).toContain('recovery_payout.recorded');
    expect(actions).toContain('recovery_payout.duplicate_ignored');
    expect(actions).toContain('settlement.reconciliation_changed');
  });
});
