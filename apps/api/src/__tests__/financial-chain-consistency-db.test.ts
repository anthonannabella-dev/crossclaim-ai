/** R46 S6 —— 只读一致性检查器 真实 PostgreSQL 验收（MSG-20261002-64 NEXT） */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hashPassword } from '../services/auth';
import { runFinancialChainConsistency } from '../services/consistency/financial-chain-checker';

const prisma = new PrismaClient();
const FAST = { N: 1024, r: 8, p: 1, keyLength: 64 };
const uuid = (): string => randomUUID();

let ORG_A = '';
let ORG_B = '';

async function seedOrg(suffix: string) {
  const id = uuid();
  await prisma.organization.create({
    data: { id, name: 'R46 S6 ' + suffix, slug: 'r46-s6-' + suffix + '-' + uuid().slice(0, 8) },
  });
  const user = await prisma.user.create({
    data: {
      email: 'r46-s6-' + suffix + '-' + uuid().slice(0, 8) + '@example.com',
      passwordHash: hashPassword('r46-s6-pass-123', FAST),
      displayName: 'OWNER',
      status: 'ACTIVE',
      emailVerified: true,
    },
  });
  await prisma.membership.create({ data: { organizationId: id, userId: user.id, role: 'OWNER', isActive: true } });
  return { organizationId: id, userId: user.id };
}

async function withDisabledTriggers<T>(table: string, fn: () => Promise<T>): Promise<T> {
  await prisma.$executeRawUnsafe('ALTER TABLE "' + table + '" DISABLE TRIGGER USER');
  try {
    return await fn();
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE "' + table + '" ENABLE TRIGGER USER');
  }
}

async function seedChain(organizationId: string, options: { feeAmount?: string; currency?: string } = {}) {
  const amount = options.feeAmount ?? '150.0000';
  const currency = options.currency ?? 'USD';
  const evidence = await prisma.evidenceArtifact.create({
    data: { organizationId, kind: 'OTHER', title: 's6 evidence' },
    select: { id: true },
  });
  const kase = await prisma.case.create({
    data: {
      organizationId,
      caseNo: 'S6-' + uuid().slice(0, 8),
      title: 'R46 S6 chain',
      domain: 'PLATFORM',
      status: 'OPEN',
      currency,
    },
    select: { id: true, caseNo: true },
  });
  const claim = await prisma.claimItem.create({
    data: {
      organizationId,
      platformType: 'AMAZON',
      claimType: 'FBA_REIMBURSEMENT',
      occurredAt: new Date('2026-08-01T00:00:00.000Z'),
      normalizerVersion: 'v1',
    },
    select: { id: true },
  });
  const settlement = await prisma.settlement.create({
    data: {
      organizationId,
      status: 'RECEIVED',
      source: 'PLATFORM_CREDIT',
      amount: '1000.0000',
      currency,
      receivedAt: new Date('2026-09-30T01:00:00.000Z'),
      evidenceId: evidence.id,
      confirmationStatus: 'CONFIRMED',
      reconciliationStatus: 'RECONCILED',
      linkageBasisKind: 'CLAIM_ITEM_DIRECT',
      claimItemId: claim.id,
      caseId: kase.id,
    },
    select: { id: true },
  });
  const fee = await prisma.feeCalculation.create({
    data: {
      organizationId,
      caseId: kase.id,
      claimItemId: claim.id,
      feeChainId: uuid(),
      basis: 'RECOVERED_AMOUNT_PCT',
      rate: '0.15',
      baseAmount: '1000.0000',
      feeAmount: amount,
      currency,
      computation: { algorithmVersion: 'settlement-fee/v1' },
      membershipDigest: 'a'.repeat(64),
      feeBasisVersion: 'v1',
      policyRef: 'policy-2026-01',
    },
    select: { id: true },
  });
  const invoice = await prisma.billingInvoice.create({
    data: {
      organizationId,
      caseId: kase.id,
      invoiceNo: 'BILL-' + kase.caseNo,
      status: 'DRAFT',
      subtotal: amount,
      taxAmount: '0.0000',
      total: amount,
      currency,
      fees: { connect: { id: fee.id } },
    },
    select: { id: true },
  });
  const membership = await prisma.feeCalculationSettlement.create({
    data: {
      organizationId,
      feeCalculationId: fee.id,
      settlementId: settlement.id,
      basisRole: 'POSITIVE',
      amountContribution: '1000.0000',
      currency,
    },
    select: { id: true },
  });
  return {
    caseId: kase.id,
    claimItemId: claim.id,
    settlementId: settlement.id,
    feeId: fee.id,
    invoiceId: invoice.id,
    membershipId: membership.id,
    feeChainId: (await prisma.feeCalculation.findFirstOrThrow({ where: { id: fee.id }, select: { feeChainId: true } })).feeChainId,
  };
}

beforeAll(async () => {
  const a = await seedOrg('a');
  ORG_A = a.organizationId;
  const b = await seedOrg('b');
  ORG_B = b.organizationId;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('R46 S6 只读一致性检查器（真实 PostgreSQL）', () => {
  it('干净链路 → ok 且无 findings；检查计数覆盖全部 8 类', async () => {
    const chain = await seedChain(ORG_A);
    const report = await runFinancialChainConsistency(prisma, { organizationId: ORG_A });
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.checked.SETTLEMENT_NET_CHAIN).toBeGreaterThan(0);
    expect(report.checked.FEE_MEMBERSHIP_CONSISTENCY).toBeGreaterThan(0);
    expect(report.checked.FEE_INVOICE_LINKAGE).toBeGreaterThan(0);
    expect(Object.keys(report.checked)).toHaveLength(8);
    expect(chain.feeId).toBeTruthy();
  });

  it('SETTLEMENT_NET_CHAIN：反向总额超过原 Settlement → 报错', async () => {
    const chain = await seedChain(ORG_A);
    await withDisabledTriggers('SettlementAdjustment', async () => {
      await prisma.settlementAdjustment.create({
        data: {
          organizationId: ORG_A,
          originalSettlementId: chain.settlementId,
          adjustmentKind: 'REVERSAL',
          amount: '1500.0000',
          currency: 'USD',
          occurredAt: new Date('2026-10-01T02:00:00.000Z'),
          externalIdentityKind: 'BANK_TRANSACTION',
          externalIdentityValueHash: uuid().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
          externalIdentityVersion: 'v1',
          evidenceReferences: [{ evidenceArtifactId: uuid() }],
          reasonCode: 'PROVIDER_CHARGEBACK',
          approvalId: uuid(),
        },
      });
    });
    const report = await runFinancialChainConsistency(prisma, { organizationId: ORG_A });
    expect(report.findings.some((f) => f.code === 'SETTLEMENT_NET_CHAIN')).toBe(true);
  });

  it('FEE_MEMBERSHIP_CONSISTENCY：membership 的 feeChainId 与父 calculation 不一致 → 报错', async () => {
    const chain = await seedChain(ORG_A);
    await withDisabledTriggers('FeeCalculationSettlement', async () => {
      await prisma.feeCalculationSettlement.update({
        where: { id: chain.membershipId },
        data: { feeChainId: uuid() },
      });
    });
    const report = await runFinancialChainConsistency(prisma, { organizationId: ORG_A });
    expect(report.findings.some((f) => f.code === 'FEE_MEMBERSHIP_CONSISTENCY')).toBe(true);
  });

  it('FEE_ADJUSTMENT_CONSISTENCY / ORPHAN_REFERENCE：REVERSAL 调整缺触发事实 + 悬空引用 → 报错', async () => {
    const chain = await seedChain(ORG_A);
    await prisma.feeCalculationAdjustment.create({
      data: {
        organizationId: ORG_A,
        targetFeeCalculationId: chain.feeId,
        adjustmentKind: 'REVERSAL',
        amount: '150.0000',
        currency: 'USD',
        triggerSettlementAdjustmentIds: [uuid()],
        evidenceReferences: [{ evidenceArtifactId: uuid() }],
        reasonCode: 'REVERSAL_APPLIED',
        approvalId: uuid(),
      },
    });
    const report = await runFinancialChainConsistency(prisma, { organizationId: ORG_A });
    expect(report.findings.some((f) => f.code === 'ORPHAN_REFERENCE')).toBe(true);
  });

  it('FEE_INVOICE_LINKAGE：fee 币种与发票币种不一致 → 报错', async () => {
    const chain = await seedChain(ORG_A);
    await withDisabledTriggers('FeeCalculation', async () => {
      await prisma.feeCalculation.update({ where: { id: chain.feeId }, data: { currency: 'EUR' } });
    });
    const report = await runFinancialChainConsistency(prisma, { organizationId: ORG_A });
    expect(report.findings.some((f) => f.code === 'FEE_INVOICE_LINKAGE')).toBe(true);
  });

  it('INVOICE_BASIS_REBUILD：发票 basis digest 被篡改 → 无法重建 → 报错', async () => {
    const chain = await seedChain(ORG_A);
    await withDisabledTriggers('BillingInvoice', async () => {
      await prisma.billingInvoice.update({
        where: { id: chain.invoiceId },
        data: { invoiceBasisDigest: 'f'.repeat(64), invoiceBasisVersion: 'invoice-basis/v1' },
      });
    });
    const report = await runFinancialChainConsistency(prisma, { organizationId: ORG_A });
    expect(report.findings.some((f) => f.code === 'INVOICE_BASIS_REBUILD')).toBe(true);
  });

  it('TENANT_BOUNDARY：membership 与父 calculation 跨租户 → 报错', async () => {
    const chain = await seedChain(ORG_A);
    await withDisabledTriggers('FeeCalculationSettlement', async () => {
      await prisma.feeCalculationSettlement.update({
        where: { id: chain.membershipId },
        data: { organizationId: ORG_B },
      });
    });
    const report = await runFinancialChainConsistency(prisma, { organizationId: ORG_B });
    expect(report.findings.some((f) => f.code === 'TENANT_BOUNDARY')).toBe(true);
  });

  it('PAYMENT_SIDE_EFFECTS：发票携带 paidAmount → 报错（支付域关闭）', async () => {
    const chain = await seedChain(ORG_A);
    await prisma.billingInvoice.update({ where: { id: chain.invoiceId }, data: { paidAmount: '50.0000' } });
    const report = await runFinancialChainConsistency(prisma, { organizationId: ORG_A });
    expect(report.findings.some((f) => f.code === 'PAYMENT_SIDE_EFFECTS')).toBe(true);
  });
});
