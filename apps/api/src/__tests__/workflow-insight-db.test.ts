/**
 * C-0009.1 P0 — D1/D2 insight against real PostgreSQL.
 * ------------------------------------------------------------------
 * Produces the checkpoint's sample output from a real chain:
 *   CanonicalFact(INVOICE) + RuleVersion + RuleEvaluation + RecoveryOpportunity
 * and proves tenant isolation + role gate.
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ForbiddenError,
  getOpportunityInsight,
  listOpportunityInsights,
  toExportRows,
} from '../services/workflow';

const prisma = new PrismaClient();
const ORG = 'ad000000-0000-4000-8000-00000000000a';
const ORG_B = 'ad000000-0000-4000-8000-00000000000b';
const EVALUATED_AT = new Date('2026-09-28T18:00:00Z');

let opsId = '';

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "BillingInvoice", "FeeCalculation", "RecoveryLedgerEntry", "Settlement", "Claim", "CaseEvidence", "EvidenceArtifact", "RecoveryRoute", "CaseOpportunity", "Case", "RuleEvaluation", "RecoveryOpportunity", "RuleVersion", "RuleSet", "CanonicalFactSource", "CanonicalFact", "SourceTransaction", "ImportBatch", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.createMany({
    data: [
      { id: ORG, name: '洞察租户', slug: 'insight-org' },
      { id: ORG_B, name: '外部租户', slug: 'insight-org-b' },
    ],
  });
  const ops = await prisma.user.create({
    data: { email: 'insight-ops@example.com', displayName: '运营', status: 'ACTIVE' },
  });
  opsId = ops.id;
  await prisma.membership.create({
    data: { organizationId: ORG, userId: ops.id, role: 'OPS', isActive: true },
  });
});

/** 真实链路：规则版本 + 发票事实 + 规则评估 + 机会 */
async function seedInsightChain(organizationId = ORG, label = 'INSIGHT-1') {
  const ruleSet = await prisma.ruleSet.create({
    data: {
      organizationId: null,
      ownerType: 'SYSTEM',
      ownerKey: 'SYSTEM',
      domain: 'LOGISTICS',
      channel: 'OTHER',
      scope: 'FREIGHT_RATE',
      name: `freight-rate-${label}`,
      description: 'fixture',
    },
  });
  const ruleVersion = await prisma.ruleVersion.create({
    data: {
      ruleSetId: ruleSet.id,
      organizationId: null,
      tier: 'CUSTOMER_CONTRACT',
      source: 'contract-2026',
      version: 'FREIGHT_RATE_V1',
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      definition: { contract: 'UPS-2026', method: 'rate_card_compare' },
    },
  });
  const fact = await prisma.canonicalFact.create({
    data: {
      organizationId,
      domain: 'LOGISTICS',
      channel: 'OTHER',
      factKey: `INVOICE:${label}`,
      referenceType: 'INVOICE',
      externalId: label,
      amount: new Prisma.Decimal('20.4125'),
      currency: 'USD',
      occurredAt: new Date('2026-09-15T00:00:00Z'),
    },
  });
  const opportunity = await prisma.recoveryOpportunity.create({
    data: {
      organizationId,
      domain: 'LOGISTICS',
      channel: 'OTHER',
      status: 'DETECTED',
      opportunityType: 'FREIGHT_RATE_VARIANCE',
      title: `UPS 燃油附加费差异 ${label}`,
      amountExpected: new Prisma.Decimal('17.7500'),
      amountActual: new Prisma.Decimal('20.4125'),
      recoverableAmount: new Prisma.Decimal('2.6625'),
      currency: 'USD',
      detectedAt: EVALUATED_AT,
    },
  });
  await prisma.ruleEvaluation.create({
    data: {
      organizationId,
      ruleVersionId: ruleVersion.id,
      canonicalFactId: fact.id,
      opportunityId: opportunity.id,
      result: 'OPPORTUNITY',
      message: 'invoiced 20.4125 exceeded contracted 17.7500',
      computed: { definitionHash: 'abc123', expected: '17.7500', actual: '20.4125' },
      evaluatedAt: EVALUATED_AT,
    },
  });
  return { opportunity, ruleVersion, fact };
}

describe('C-0009.1 — D1/D2 洞察（真实 PostgreSQL 样例）', () => {
  it('输出可复核的复算证据块（含 calculation timestamp）与导出列', async () => {
    const { opportunity } = await seedInsightChain();

    const insight = await getOpportunityInsight(prisma, { organizationId: ORG, role: 'OPS' }, opportunity.id);

    // —— 检查点用样例输出（D1/D2）——
    expect(insight.summary).toEqual({
      invoiceReference: 'INSIGHT-1',
      amountDifference: '2.6625',
      basis: 'FREIGHT_RATE_V1（CUSTOMER_CONTRACT）· 来源 contract-2026',
    });
    expect(insight.calculation.invoiceReference).toBe('INSIGHT-1');
    expect(insight.calculation.ruleVersion).toBe('FREIGHT_RATE_V1 (CUSTOMER_CONTRACT)');
    expect(insight.calculation.rateSource).toBe('contract-2026');
    expect(insight.calculation.calculationDetail).toContain('expected=17.7500');
    expect(insight.calculation.calculationDetail).toContain('actual=20.4125');
    expect(insight.calculation.calculationDetail).toContain('recoverable=2.6625');
    expect(insight.calculation.calculationDetail).toContain('definitionHash=abc123');
    // 规则版本会变化 → 必须能回答"当时按什么版本算"
    expect(insight.calculation.calculationTimestamp).toBe('2026-09-28T18:00:00.000Z');

    const rows = toExportRows([insight]);
    expect(rows[0]).toMatchObject({
      opportunityId: opportunity.id,
      invoiceReference: 'INSIGHT-1',
      recoverableAmount: '2.6625',
      ruleReason: 'FREIGHT_RATE_V1（CUSTOMER_CONTRACT）· 来源 contract-2026',
      evidenceReference: 'contract-2026',
    });

    // 导出与接口都不得泄漏凭据类字段
    expect(JSON.stringify(insight)).not.toMatch(/password|token|credential|secret/i);
  });

  it('列表按租户隔离；FINANCE 无权读取洞察', async () => {
    await seedInsightChain(ORG, 'INSIGHT-A');
    await seedInsightChain(ORG_B, 'INSIGHT-B');

    const mine = await listOpportunityInsights(prisma, { organizationId: ORG, role: 'OPS' });
    expect(mine).toHaveLength(1);
    expect(mine[0].summary.invoiceReference).toBe('INSIGHT-A');

    await expect(
      listOpportunityInsights(prisma, { organizationId: ORG, role: 'FINANCE' }),
    ).rejects.toThrow(ForbiddenError);
    expect(opsId).toBeTruthy();
  });
});
