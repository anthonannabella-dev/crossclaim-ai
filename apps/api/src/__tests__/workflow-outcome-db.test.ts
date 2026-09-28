/**
 * C-0008-B2-3a — confirmRecoveryOutcome against real PostgreSQL.
 * ------------------------------------------------------------------
 * Proves the approved money-chain contract of a *manual* recovery confirmation:
 *   · Settlement (external fact) → Ledger → FeeCalculation → BillingInvoice(DRAFT)
 *   · deterministic fee = round4(recoveredAmount × confirmed rate), all Decimal
 *   · NEVER auto-advances Claim APPROVED / Case WON (both must already hold)
 *   · commercial terms must already be confirmed
 *   · at most one Settlement per case (idempotent), currency/amount guards,
 *     exceeds-claim records a warning audit instead of blocking
 *   · every write is attributed to the signed-in user
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { confirmRecoveryOutcome } from '../services/workflow';
import { ForbiddenError } from '../services/workflow';

const prisma = new PrismaClient();
const ORG = 'ee000000-0000-4000-8000-00000000000a';
const ORG_B = 'ee000000-0000-4000-8000-00000000000b';
const NOW = new Date('2026-09-28T18:00:00Z');
const RATE = '0.1500';

let adminId = '';
let financeId = '';
let opsId = '';

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "BillingInvoice", "FeeCalculation", "RecoveryLedgerEntry", "Settlement", "Claim", "CaseEvidence", "EvidenceArtifact", "RecoveryRoute", "CaseOpportunity", "Case", "RecoveryOpportunity", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.createMany({
    data: [
      { id: ORG, name: '回收确认租户', slug: 'outcome-org' },
      { id: ORG_B, name: '外部租户', slug: 'outcome-org-b' },
    ],
  });
  const [admin, finance, ops] = await Promise.all([
    prisma.user.create({ data: { email: 'outcome-admin@example.com', displayName: '管理员', status: 'ACTIVE' } }),
    prisma.user.create({ data: { email: 'outcome-finance@example.com', displayName: '财务', status: 'ACTIVE' } }),
    prisma.user.create({ data: { email: 'outcome-ops@example.com', displayName: '运营', status: 'ACTIVE' } }),
  ]);
  adminId = admin.id;
  financeId = finance.id;
  opsId = ops.id;
  await prisma.membership.createMany({
    data: [
      { organizationId: ORG, userId: admin.id, role: 'ADMIN', isActive: true },
      { organizationId: ORG, userId: finance.id, role: 'FINANCE', isActive: true },
      { organizationId: ORG, userId: ops.id, role: 'OPS', isActive: true },
    ],
  });
});

/** Case at WON + Claim APPROVED + confirmed commercial terms (the manual facts). */
async function seedSettledCase(options: { caseStatus?: string; claimStatus?: string; withTerms?: boolean; claimedAmount?: string; organizationId?: string } = {}) {
  const organizationId = options.organizationId ?? ORG;
  const opportunity = await prisma.recoveryOpportunity.create({
    data: {
      organizationId,
      domain: 'LOGISTICS',
      channel: 'OTHER',
      status: 'CONVERTED',
      opportunityType: 'FREIGHT_RATE_VARIANCE',
      title: '回收确认用例',
      amountExpected: new Prisma.Decimal('17.7500'),
      amountActual: new Prisma.Decimal('20.4125'),
      recoverableAmount: new Prisma.Decimal('2.6625'),
      currency: 'USD',
      detectedAt: NOW,
    },
  });
  const kase = await prisma.case.create({
    data: {
      organizationId,
      caseNo: `CASE-${opportunity.id}`,
      title: '回收确认案件',
      domain: 'LOGISTICS',
      status: (options.caseStatus ?? 'WON') as Prisma.CaseCreateInput['status'],
      claimedAmount: new Prisma.Decimal(options.claimedAmount ?? '2.6625'),
      currency: 'USD',
    },
  });
  await prisma.caseOpportunity.create({
    data: { organizationId, caseId: kase.id, opportunityId: opportunity.id },
  });
  const claim = await prisma.claim.create({
    data: {
      organizationId,
      caseId: kase.id,
      round: 1,
      status: (options.claimStatus ?? 'APPROVED') as Prisma.ClaimCreateInput['status'],
      target: 'CARRIER',
      aiDraftText: 'draft',
    },
  });
  if (options.withTerms !== false) {
    await prisma.auditLog.create({
      data: {
        organizationId,
        actorType: 'USER',
        actorUserId: adminId,
        action: 'commercial_terms.created',
        entityType: 'Case',
        entityId: kase.id,
        changes: { successFeeRate: RATE, source: 'manual_input', reConfirmed: false },
        createdAt: NOW,
      },
    });
  }
  return { opportunity, kase, claim };
}

const confirm = (caseId: string, overrides: Record<string, unknown> = {}, role = 'FINANCE', actor = financeId) =>
  confirmRecoveryOutcome(
    prisma,
    {
      organizationId: ORG,
      actorUserId: actor,
      role,
      caseId,
      recoveredAmount: '2.6625',
      currency: 'USD',
      basisReference: 'carrier-email-20260928',
      ...overrides,
    },
    () => NOW,
  );

describe('C-0008-B2-3a — 人工确认回收结果（真实 PostgreSQL）', () => {
  it('写 Settlement → Ledger → Fee → Billing(DRAFT)，费用确定性，且不自动改变人工事实', async () => {
    const { kase, claim } = await seedSettledCase();
    const result = await confirm(kase.id);

    expect(result.created).toBe(true);
    expect(result.recoveredAmount).toBe('2.6625');
    expect(result.feeAmount).toBe('0.3994'); // 2.6625 × 0.15 = 0.399375 → HALF_UP 4 位
    expect(result.exceedsClaim).toBe(false);

    const settlement = await prisma.settlement.findUniqueOrThrow({ where: { id: result.settlementId } });
    expect(settlement).toMatchObject({ caseId: kase.id, status: 'RECEIVED', source: 'OTHER', currency: 'USD' });
    expect(settlement.amount.toFixed(4)).toBe('2.6625');

    const ledger = await prisma.recoveryLedgerEntry.findUniqueOrThrow({ where: { id: result.ledgerEntryId } });
    expect(ledger).toMatchObject({ entryType: 'RECOVERED', currency: 'USD' });
    expect(ledger.amount.toFixed(4)).toBe('2.6625');

    const fee = await prisma.feeCalculation.findUniqueOrThrow({ where: { id: result.feeCalculationId } });
    expect(fee).toMatchObject({ basis: 'RECOVERED_AMOUNT_PCT' });
    expect(fee.rate?.toFixed(4)).toBe(RATE);
    expect(fee.baseAmount.toFixed(4)).toBe('2.6625');
    expect(fee.feeAmount.toFixed(4)).toBe('0.3994');
    expect(fee.computation).toMatchObject({ basisReference: 'carrier-email-20260928', source: 'manual_input' });

    const billing = await prisma.billingInvoice.findUniqueOrThrow({ where: { id: result.billingInvoiceId } });
    expect(billing).toMatchObject({ status: 'DRAFT', currency: 'USD' });
    expect(billing.total.toFixed(4)).toBe('0.3994');

    const row = await prisma.case.findUniqueOrThrow({ where: { id: kase.id } });
    expect(row.recoveredAmount?.toFixed(4)).toBe('2.6625');
    // MSG-20260928-57：Case 状态保持 WON —— 资金事实由 Settlement(RECEIVED) 表达
    expect(row.status).toBe('WON');
    const claimRow = await prisma.claim.findUniqueOrThrow({ where: { id: claim.id } });
    expect(claimRow.status).toBe('APPROVED');

    // 不得出现 WON → SETTLED 的自动迁移审计
    const statusAudits = await prisma.auditLog.findMany({
      where: { organizationId: ORG, action: 'case.status_changed' },
    });
    expect(statusAudits).toHaveLength(0);

    const audits = await prisma.auditLog.findMany({
      where: { organizationId: ORG, action: 'recovery_outcome.confirmed' },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: 'USER', actorUserId: financeId, entityType: 'Settlement' });
    expect(audits[0].changes).toMatchObject({
      recoveredAmount: '2.6625',
      currency: 'USD',
      basisReference: 'carrier-email-20260928',
    });
  });

  it('幂等：重复确认不产生第二条 Settlement / Fee / Billing', async () => {
    const { kase } = await seedSettledCase();
    const first = await confirm(kase.id);
    const second = await confirm(kase.id);

    expect(second.created).toBe(false);
    expect(second.settlementId).toBe(first.settlementId);
    expect(await prisma.settlement.count({ where: { organizationId: ORG } })).toBe(1);
    expect(await prisma.recoveryLedgerEntry.count({ where: { organizationId: ORG } })).toBe(1);
    expect(await prisma.feeCalculation.count({ where: { organizationId: ORG } })).toBe(1);
    expect(await prisma.billingInvoice.count({ where: { organizationId: ORG } })).toBe(1);
  });

  it('不自动推进：Case 非 WON 或 Claim 非 APPROVED 一律拒绝，零写入', async () => {
    const notWon = await seedSettledCase({ caseStatus: 'CLAIMED' });
    await expect(confirm(notWon.kase.id)).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });

    const notApproved = await seedSettledCase({ claimStatus: 'SUBMITTED' });
    await expect(confirm(notApproved.kase.id)).rejects.toMatchObject({ code: 'CLAIM_NOT_APPROVED' });

    expect(await prisma.settlement.count()).toBe(0);
    expect(await prisma.billingInvoice.count()).toBe(0);
  });

  it('费率未确认 → COMMERCIAL_TERMS_PENDING，零写入', async () => {
    const { kase } = await seedSettledCase({ withTerms: false });
    await expect(confirm(kase.id)).rejects.toMatchObject({ code: 'COMMERCIAL_TERMS_PENDING' });
    expect(await prisma.settlement.count()).toBe(0);
  });

  it('币种不一致与非法金额被拒；跨租户 → NOT_FOUND；OPS → Forbidden', async () => {
    const { kase } = await seedSettledCase();
    await expect(confirm(kase.id, { currency: 'EUR' })).rejects.toMatchObject({ code: 'CURRENCY_MISMATCH' });
    await expect(confirm(kase.id, { recoveredAmount: '0' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(confirm(kase.id, { basisReference: '  ' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(confirm(kase.id, {}, 'OPS', opsId)).rejects.toThrow(ForbiddenError);

    // 外部租户的机会/案件无需商务确认审计（跨租户在更早的守卫处即被拒）
    const foreign = await seedSettledCase({ organizationId: ORG_B, withTerms: false });
    await expect(confirm(foreign.kase.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(await prisma.settlement.count()).toBe(0);
  });

  it('回收金额超过索赔金额：不阻断，但写 recovery_amount_exceeds_claim 警告审计', async () => {
    const { kase } = await seedSettledCase({ claimedAmount: '2.0000' });
    const result = await confirm(kase.id, { recoveredAmount: '5.0000' });

    expect(result.created).toBe(true);
    expect(result.exceedsClaim).toBe(true);
    expect(result.feeAmount).toBe('0.7500');

    const warnings = await prisma.auditLog.findMany({
      where: { organizationId: ORG, action: 'recovery_amount_exceeds_claim' },
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].changes).toMatchObject({ recoveredAmount: '5.0000', claimedAmount: '2.0000' });
    expect(await prisma.settlement.count({ where: { organizationId: ORG } })).toBe(1);
  });

  it('可绑定已有 EvidenceArtifact（跨租户证据被拒）', async () => {
    const { kase } = await seedSettledCase();
    const evidence = await prisma.evidenceArtifact.create({
      data: {
        organizationId: ORG,
        kind: 'CREDIT_NOTE',
        title: '银行水单',
        capturedAt: NOW,
      },
    });
    const result = await confirm(kase.id, { evidenceArtifactId: evidence.id, note: '已到账' });
    const settlement = await prisma.settlement.findUniqueOrThrow({ where: { id: result.settlementId } });
    expect(settlement.evidenceId).toBe(evidence.id);
    expect(settlement.note).toBe('已到账');
    expect(await prisma.caseEvidence.count({ where: { caseId: kase.id, evidenceId: evidence.id } })).toBe(1);

    const foreignEvidence = await prisma.evidenceArtifact.create({
      data: { organizationId: ORG_B, kind: 'CREDIT_NOTE', title: '外部证据', capturedAt: NOW },
    });
    const other = await seedSettledCase();
    await expect(confirm(other.kase.id, { evidenceArtifactId: foreignEvidence.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
