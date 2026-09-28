/**
 * C-0009.1 P0 — D1/D2 insight guards (unit).
 * ---------------------------------------------------------------
 * Role matrix (viewClaimAmounts), the D2 evidence block shape — including the
 * architect-mandated `calculationTimestamp` — and the D3 export columns.
 */

import { Prisma, type PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import {
  ForbiddenError,
  getOpportunityInsight,
  listOpportunityInsights,
  toExportRows,
  type OpportunityInsight,
} from '../services/workflow';

const ORG = 'f0000000-0000-4000-8000-000000000013';
const OPP = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function stubPrisma(hasEvaluation = true) {
  const row = {
    id: OPP,
    title: 'UPS 燃油附加费差异',
    status: 'DETECTED',
    opportunityType: 'FREIGHT_RATE_VARIANCE',
    currency: 'USD',
    amountExpected: new Prisma.Decimal('17.7500'),
    amountActual: new Prisma.Decimal('20.4125'),
    recoverableAmount: new Prisma.Decimal('2.6625'),
    evaluations: hasEvaluation
      ? [
          {
            message: 'freight rate variance detected',
            computed: { definitionHash: 'abc123' },
            evaluatedAt: new Date('2026-09-28T18:00:00Z'),
            ruleVersion: { version: 'FREIGHT_RATE_V1', tier: 'CONTRACT', source: 'contract-2026', definition: {} },
            canonicalFact: {
              factKey: 'INVOICE:INV-845234-4821',
              externalId: 'INV-845234-4821',
              referenceType: 'INVOICE',
            },
          },
        ]
      : [],
  };
  const findFirst: ReturnType<typeof vi.fn> = vi.fn(async () => row);
  const findMany: ReturnType<typeof vi.fn> = vi.fn(async () => [row]);
  return {
    prisma: {
      recoveryOpportunity: { findFirst, findMany },
    } as unknown as PrismaClient,
    findFirst,
    findMany,
  };
}

describe('C-0009.1 — 机会人话版摘要与复算证据（单元）', () => {
  it('FINANCE / VIEWER / 未知角色无权查看（触库前 403）', async () => {
    for (const role of ['FINANCE', 'VIEWER', 'UNKNOWN']) {
      const { prisma, findFirst, findMany } = stubPrisma();
      await expect(listOpportunityInsights(prisma, { organizationId: ORG, role })).rejects.toThrow(
        ForbiddenError,
      );
      await expect(
        getOpportunityInsight(prisma, { organizationId: ORG, role }, OPP),
      ).rejects.toThrow(ForbiddenError);
      expect(findFirst).not.toHaveBeenCalled();
      expect(findMany).not.toHaveBeenCalled();
    }
  });

  it('OWNER / ADMIN / OPS 可读，且摘要与证据块字段齐全', async () => {
    for (const role of ['OWNER', 'ADMIN', 'OPS']) {
      const { prisma } = stubPrisma();
      const insight = await getOpportunityInsight(prisma, { organizationId: ORG, role }, OPP);

      expect(Object.keys(insight.summary).sort()).toEqual(
        ['amountDifference', 'basis', 'invoiceReference', 'invoiceReferenceMasked'].sort(),
      );
      expect(Object.keys(insight.calculation).sort()).toEqual(
        [
          'calculationDetail',
          'calculationTimestamp',
          'invoiceReference',
          'invoiceReferenceMasked',
          'rateSource',
          'ruleVersion',
        ].sort(),
      );
      // D1：发票 / 差多少钱 / 依据
      expect(insight.summary.invoiceReference).toBe('INV-845234-4821');
      // C-0009.3 P0：展示用掩码值（客户仍可在原始文件/完整视图看到真值）
      expect(insight.summary.invoiceReferenceMasked).toBe('INV-****-4821');
      expect(insight.summary.amountDifference).toBe('2.6625');
      expect(insight.summary.basis).toContain('FREIGHT_RATE_V1');
      // D2：四要素 + 时间戳
      expect(insight.calculation.ruleVersion).toBe('FREIGHT_RATE_V1 (CONTRACT)');
      expect(insight.calculation.rateSource).toBe('contract-2026');
      expect(insight.calculation.calculationDetail).toContain('recoverable=2.6625');
      expect(insight.calculation.calculationDetail).toContain('definitionHash=abc123');
      expect(insight.calculation.calculationTimestamp).toBe('2026-09-28T18:00:00.000Z');
    }
  });

  it('没有规则评估记录时给出明确的「未找到」依据，而不是猜测', async () => {
    const { prisma } = stubPrisma(false);
    const insight = await getOpportunityInsight(prisma, { organizationId: ORG, role: 'OPS' }, OPP);
    expect(insight.summary.basis).toBe('未找到规则评估记录');
    expect(insight.calculation.ruleVersion).toBeNull();
    expect(insight.calculation.calculationTimestamp).toBeNull();
    // 金额仍来自机会本身（不推测）
    expect(insight.recoverableAmount).toBe('2.6625');
  });

  it('D3 导出列严格为架构方指定的 5 列，且不含凭据类字段', () => {
    const insight: OpportunityInsight = {
      opportunityId: OPP,
      title: 't',
      status: 'DETECTED',
      opportunityType: 'FREIGHT_RATE_VARIANCE',
      currency: 'USD',
      amountExpected: '17.7500',
      amountActual: '20.4125',
      recoverableAmount: '2.6625',
      summary: {
        invoiceReference: 'INV-845234-4821',
        invoiceReferenceMasked: 'INV-****-4821',
        amountDifference: '2.6625',
        basis: 'FREIGHT_RATE_V1 · contract-2026',
      },
      calculation: {
        invoiceReference: 'INV-845234-4821',
        invoiceReferenceMasked: 'INV-****-4821',
        ruleVersion: 'FREIGHT_RATE_V1 (CONTRACT)',
        rateSource: 'contract-2026',
        calculationDetail: 'expected=17.7500; actual=20.4125; recoverable=2.6625; currency=USD',
        calculationTimestamp: '2026-09-28T18:00:00.000Z',
      },
    };
    const rows = toExportRows([insight]);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(
      ['evidenceReference', 'invoiceReference', 'opportunityId', 'recoverableAmount', 'ruleReason'].sort(),
    );
    expect(JSON.stringify(rows)).not.toMatch(/password|token|credential|secret/i);
  });
});
