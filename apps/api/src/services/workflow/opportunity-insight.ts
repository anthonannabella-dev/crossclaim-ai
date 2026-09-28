/**
 * C-0009.1 P0 — D1/D2 read-only opportunity insight.
 * ---------------------------------------------------------------
 * D1「人话版」摘要：哪张发票 / 差多少钱 / 依据是什么
 * D2 复算证据块（验收 #7）：Invoice + RuleVersion + Rate Source +
 *    Calculation Detail + **calculation timestamp**（架构方在 MSG-20260928-67 追加，
 *    因为规则版本会变化，客户复核时需要知道"当时按什么版本算的"）
 *
 * 只读：不改检测、不改规则、不改资金链，也不新增 Schema。
 */

import { Prisma, type PrismaClient } from '@prisma/client';

import { WorkflowError } from './opportunity-review';
import { assertPermission } from './permissions';

const money = (value: InstanceType<typeof Prisma.Decimal> | null): string | null =>
  value === null
    ? null
    : new Prisma.Decimal(value).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP).toFixed(4);

export interface OpportunityInsight {
  opportunityId: string;
  title: string;
  status: string;
  opportunityType: string;
  currency: string;
  amountExpected: string | null;
  amountActual: string | null;
  recoverableAmount: string | null;
  /** D1：客户/运营可直接读懂的三行摘要 */
  summary: {
    invoiceReference: string | null;
    amountDifference: string | null;
    basis: string;
  };
  /** D2：复算证据块（验收 #7） */
  calculation: {
    invoiceReference: string | null;
    ruleVersion: string | null;
    rateSource: string | null;
    calculationDetail: string | null;
    calculationTimestamp: string | null;
  };
}

type OpportunityRow = {
  id: string;
  title: string;
  status: string;
  opportunityType: string;
  currency: string;
  amountExpected: InstanceType<typeof Prisma.Decimal> | null;
  amountActual: InstanceType<typeof Prisma.Decimal> | null;
  recoverableAmount: InstanceType<typeof Prisma.Decimal> | null;
  evaluations: Array<{
    message: string | null;
    computed: Prisma.JsonValue | null;
    evaluatedAt: Date;
    ruleVersion: {
      version: string;
      tier: string;
      source: string;
      definition: Prisma.JsonValue;
    };
    canonicalFact: { factKey: string; externalId: string | null; referenceType: string | null } | null;
  }>;
};

function toInsight(row: OpportunityRow): OpportunityInsight {
  const latest = row.evaluations[0] ?? null;
  const computed =
    latest?.computed && typeof latest.computed === 'object' && !Array.isArray(latest.computed)
      ? (latest.computed as Record<string, unknown>)
      : null;
  const invoiceReference =
    latest?.canonicalFact?.externalId ??
    latest?.canonicalFact?.factKey ??
    (typeof computed?.invoiceReference === 'string' ? computed.invoiceReference : null) ??
    null;

  const detailParts = [
    `expected=${money(row.amountExpected) ?? '—'}`,
    `actual=${money(row.amountActual) ?? '—'}`,
    `recoverable=${money(row.recoverableAmount) ?? '—'}`,
    `currency=${row.currency}`,
  ];
  if (computed && typeof computed.definitionHash === 'string') {
    detailParts.push(`definitionHash=${computed.definitionHash}`);
  }
  if (latest?.ruleVersion) {
    detailParts.push(`ruleVersion=${latest.ruleVersion.version}(${latest.ruleVersion.tier})`);
  }

  const basis = latest?.ruleVersion
    ? `${latest.ruleVersion.version}（${latest.ruleVersion.tier}）· 来源 ${latest.ruleVersion.source}`
    : '未找到规则评估记录';

  return {
    opportunityId: row.id,
    title: row.title,
    status: row.status,
    opportunityType: row.opportunityType,
    currency: row.currency,
    amountExpected: money(row.amountExpected),
    amountActual: money(row.amountActual),
    recoverableAmount: money(row.recoverableAmount),
    summary: {
      invoiceReference,
      amountDifference: money(row.recoverableAmount),
      basis,
    },
    calculation: {
      invoiceReference,
      ruleVersion: latest?.ruleVersion
        ? `${latest.ruleVersion.version} (${latest.ruleVersion.tier})`
        : null,
      rateSource: latest?.ruleVersion?.source ?? null,
      calculationDetail: detailParts.join('; '),
      // 架构方追加要求：必须给出"当时按什么版本算的"时间点
      calculationTimestamp: latest?.evaluatedAt ? latest.evaluatedAt.toISOString() : null,
    },
  };
}

const SELECT = {
  id: true,
  title: true,
  status: true,
  opportunityType: true,
  currency: true,
  amountExpected: true,
  amountActual: true,
  recoverableAmount: true,
  evaluations: {
    orderBy: { evaluatedAt: 'desc' as const },
    take: 1,
    select: {
      message: true,
      computed: true,
      evaluatedAt: true,
      ruleVersion: { select: { version: true, tier: true, source: true, definition: true } },
      canonicalFact: { select: { factKey: true, externalId: true, referenceType: true } },
    },
  },
};

export async function listOpportunityInsights(
  prisma: PrismaClient,
  actor: { organizationId: string; role: string },
  limit = 50,
): Promise<OpportunityInsight[]> {
  assertPermission(actor.role, 'viewClaimAmounts');
  const take = Math.min(Math.max(limit, 1), 200);

  const rows = await prisma.recoveryOpportunity.findMany({
    where: { organizationId: actor.organizationId },
    orderBy: { detectedAt: 'desc' },
    take,
    select: SELECT,
  });
  return rows.map((row) => toInsight(row as OpportunityRow));
}

export async function getOpportunityInsight(
  prisma: PrismaClient,
  actor: { organizationId: string; role: string },
  opportunityId: string,
): Promise<OpportunityInsight> {
  assertPermission(actor.role, 'viewClaimAmounts');

  const row = await prisma.recoveryOpportunity.findFirst({
    where: { id: opportunityId, organizationId: actor.organizationId },
    select: SELECT,
  });
  if (!row) {
    throw new WorkflowError('NOT_FOUND', `机会 ${opportunityId} 不存在或不属于该租户`);
  }
  return toInsight(row as OpportunityRow);
}

/** D3：导出用行（架构方指定必须包含的字段） */
export interface OpportunityExportRow {
  opportunityId: string;
  invoiceReference: string;
  recoverableAmount: string;
  ruleReason: string;
  evidenceReference: string;
}

export function toExportRows(insights: OpportunityInsight[]): OpportunityExportRow[] {
  return insights.map((insight) => ({
    opportunityId: insight.opportunityId,
    invoiceReference: insight.calculation.invoiceReference ?? '',
    recoverableAmount: insight.recoverableAmount ?? '',
    ruleReason: insight.summary.basis,
    // 证据引用：优先案件证据，其次规则版本来源（导出只给引用，不给文件内容）
    evidenceReference: insight.calculation.rateSource ?? '',
  }));
}
