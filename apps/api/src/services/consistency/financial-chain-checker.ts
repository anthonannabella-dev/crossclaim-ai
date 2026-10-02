/**
 * R46 S6 —— 只读一致性检查器（Financial Chain Consistency Checker）
 * ------------------------------------------------------------------
 * 依据：MSG-20261002-64 NEXT —— 「read-only consistency checker + complete regression closure」，
 * 只允许只读校验：Settlement/Adjustment 净额链 · FeeCalculation membership 一致性 ·
 * FeeAdjustment 一致性 · Fee↔Invoice immutable linkage · invoice basis digest 可重建 ·
 * tenant boundaries · orphan/reference detection · no hidden Payment side effects。
 *
 * 边界：**只读**（全部为 SELECT），不写任何事实、不触发 Payment/autopay/外部写。
 */

import type { PrismaClient } from '@prisma/client';

import { computeInvoiceBasis } from '../billing/invoice-basis';

export type ConsistencyCode =
  | 'SETTLEMENT_NET_CHAIN'
  | 'FEE_MEMBERSHIP_CONSISTENCY'
  | 'FEE_ADJUSTMENT_CONSISTENCY'
  | 'FEE_INVOICE_LINKAGE'
  | 'INVOICE_BASIS_REBUILD'
  | 'TENANT_BOUNDARY'
  | 'ORPHAN_REFERENCE'
  | 'PAYMENT_SIDE_EFFECTS';

export interface ConsistencyFinding {
  code: ConsistencyCode;
  severity: 'ERROR' | 'WARN';
  entityType: string;
  entityId: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ConsistencyReport {
  organizationId: string;
  ok: boolean;
  checked: Record<ConsistencyCode, number>;
  findings: ConsistencyFinding[];
}

interface Row {
  [key: string]: unknown;
}

const str = (value: unknown): string => (value === null || value === undefined ? '' : String(value));

async function settlementNetChain(prisma: PrismaClient, organizationId: string, report: ConsistencyReport) {
  const rows = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT s."id", s."amount"::text AS amount, s."currency" AS currency, s."status" AS status,
            s."reversedBySettlementId" AS reversed_by,
            COALESCE(adj.total, 0)::text AS reversal_total,
            COALESCE(adj.cnt, 0)::int AS reversal_count
       FROM "Settlement" s
       LEFT JOIN (
         SELECT a."originalSettlementId" AS sid, SUM(a."amount") AS total, COUNT(*) AS cnt
           FROM "SettlementAdjustment" a
          WHERE a."organizationId" = $1 AND a."adjustmentKind" = 'REVERSAL'
          GROUP BY a."originalSettlementId") adj ON adj.sid = s."id"
      WHERE s."organizationId" = $1`,
    organizationId,
  );
  report.checked.SETTLEMENT_NET_CHAIN = rows.length;
  for (const row of rows) {
    const amount = Number(row.amount);
    const reversalTotal = Number(row.reversal_total);
    if (reversalTotal > amount) {
      report.findings.push({
        code: 'SETTLEMENT_NET_CHAIN',
        severity: 'ERROR',
        entityType: 'Settlement',
        entityId: str(row.id),
        message: 'reverse total exceeds original settlement amount',
        details: { amount: str(row.amount), reversalTotal: str(row.reversal_total) },
      });
    }
    if (Number(row.reversal_count) > 1) {
      report.findings.push({
        code: 'SETTLEMENT_NET_CHAIN',
        severity: 'ERROR',
        entityType: 'Settlement',
        entityId: str(row.id),
        message: 'more than one REVERSAL adjustment exists (v1 allows at most one)',
        details: { reversalCount: Number(row.reversal_count) },
      });
    }
    if (str(row.reversed_by) && Number(row.reversal_count) === 0) {
      report.findings.push({
        code: 'SETTLEMENT_NET_CHAIN',
        severity: 'ERROR',
        entityType: 'Settlement',
        entityId: str(row.id),
        message: 'settlement is marked reversed but has no REVERSAL adjustment fact',
      });
    }
  }
}

async function feeMembershipConsistency(prisma: PrismaClient, organizationId: string, report: ConsistencyReport) {
  const rows = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT m."id", m."organizationId" AS m_org, m."feeChainId" AS m_chain, m."settlementId" AS settlement_id,
            f."id" AS fee_id, f."organizationId" AS f_org, f."feeChainId" AS f_chain
       FROM "FeeCalculationSettlement" m
       JOIN "FeeCalculation" f ON f."id" = m."feeCalculationId"
      WHERE m."organizationId" = $1`,
    organizationId,
  );
  report.checked.FEE_MEMBERSHIP_CONSISTENCY = rows.length;
  for (const row of rows) {
    if (str(row.m_org) !== str(row.f_org)) {
      report.findings.push({
        code: 'TENANT_BOUNDARY',
        severity: 'ERROR',
        entityType: 'FeeCalculationSettlement',
        entityId: str(row.id),
        message: 'membership tenant differs from parent fee calculation tenant',
      });
    }
    if (row.m_chain !== null && row.f_chain !== null && str(row.m_chain) !== str(row.f_chain)) {
      report.findings.push({
        code: 'FEE_MEMBERSHIP_CONSISTENCY',
        severity: 'ERROR',
        entityType: 'FeeCalculationSettlement',
        entityId: str(row.id),
        message: 'membership feeChainId does not match parent fee calculation chain',
        details: { membershipChain: str(row.m_chain), parentChain: str(row.f_chain) },
      });
    }
  }

  const emptyFees = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT f."id" FROM "FeeCalculation" f
      WHERE f."organizationId" = $1
        AND NOT EXISTS (SELECT 1 FROM "FeeCalculationSettlement" m WHERE m."feeCalculationId" = f."id")`,
    organizationId,
  );
  for (const row of emptyFees) {
    report.findings.push({
      code: 'FEE_MEMBERSHIP_CONSISTENCY',
      severity: 'ERROR',
      entityType: 'FeeCalculation',
      entityId: str(row.id),
      message: 'fee calculation has no membership rows',
    });
  }
}

async function feeAdjustmentConsistency(prisma: PrismaClient, organizationId: string, report: ConsistencyReport) {
  const rows = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT a."id", a."adjustmentKind" AS kind, a."amount"::text AS amount, a."organizationId" AS a_org,
            a."triggerSettlementAdjustmentIds" AS triggers,
            f."id" AS fee_id, f."organizationId" AS f_org
       FROM "FeeCalculationAdjustment" a
       LEFT JOIN "FeeCalculation" f ON f."id" = a."targetFeeCalculationId"
      WHERE a."organizationId" = $1`,
    organizationId,
  );
  report.checked.FEE_ADJUSTMENT_CONSISTENCY = rows.length;
  for (const row of rows) {
    if (!row.fee_id) {
      report.findings.push({
        code: 'ORPHAN_REFERENCE',
        severity: 'ERROR',
        entityType: 'FeeCalculationAdjustment',
        entityId: str(row.id),
        message: 'target fee calculation does not exist',
      });
      continue;
    }
    if (str(row.a_org) !== str(row.f_org)) {
      report.findings.push({
        code: 'TENANT_BOUNDARY',
        severity: 'ERROR',
        entityType: 'FeeCalculationAdjustment',
        entityId: str(row.id),
        message: 'adjustment tenant differs from target fee calculation tenant',
      });
    }
    if (Number(row.amount) <= 0) {
      report.findings.push({
        code: 'FEE_ADJUSTMENT_CONSISTENCY',
        severity: 'ERROR',
        entityType: 'FeeCalculationAdjustment',
        entityId: str(row.id),
        message: 'adjustment amount must be positive (direction is expressed by kind)',
      });
    }
    const triggers = Array.isArray(row.triggers) ? (row.triggers as unknown[]).map(String) : [];
    if (str(row.kind) === 'REVERSAL' && triggers.length === 0) {
      report.findings.push({
        code: 'FEE_ADJUSTMENT_CONSISTENCY',
        severity: 'ERROR',
        entityType: 'FeeCalculationAdjustment',
        entityId: str(row.id),
        message: 'REVERSAL adjustment must reference at least one settlement adjustment',
      });
    }
    for (const triggerId of triggers) {
      const found = await prisma.$queryRawUnsafe<Row[]>(
        `SELECT "id" FROM "SettlementAdjustment"
          WHERE "id" = $1 AND "organizationId" = $2 AND "adjustmentKind" = 'REVERSAL'`,
        triggerId,
        organizationId,
      );
      if (found.length === 0) {
        report.findings.push({
          code: 'ORPHAN_REFERENCE',
          severity: 'ERROR',
          entityType: 'FeeCalculationAdjustment',
          entityId: str(row.id),
          message: 'trigger settlement adjustment reference is missing or not a REVERSAL in tenant',
          details: { triggerId },
        });
      }
    }
  }
}

async function feeInvoiceLinkage(prisma: PrismaClient, organizationId: string, report: ConsistencyReport) {
  const rows = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT f."id", f."billingInvoiceId" AS invoice_id, f."currency" AS fee_currency, f."organizationId" AS f_org,
            i."id" AS inv_id, i."currency" AS inv_currency, i."organizationId" AS i_org, i."status" AS inv_status
       FROM "FeeCalculation" f
       LEFT JOIN "BillingInvoice" i ON i."id" = f."billingInvoiceId"
      WHERE f."organizationId" = $1 AND f."billingInvoiceId" IS NOT NULL`,
    organizationId,
  );
  report.checked.FEE_INVOICE_LINKAGE = rows.length;
  for (const row of rows) {
    if (!row.inv_id) {
      report.findings.push({
        code: 'ORPHAN_REFERENCE',
        severity: 'ERROR',
        entityType: 'FeeCalculation',
        entityId: str(row.id),
        message: 'linked billing invoice does not exist',
      });
      continue;
    }
    if (str(row.f_org) !== str(row.i_org)) {
      report.findings.push({
        code: 'TENANT_BOUNDARY',
        severity: 'ERROR',
        entityType: 'FeeCalculation',
        entityId: str(row.id),
        message: 'fee and invoice belong to different tenants',
      });
    }
    if (str(row.fee_currency) !== str(row.inv_currency)) {
      report.findings.push({
        code: 'FEE_INVOICE_LINKAGE',
        severity: 'ERROR',
        entityType: 'FeeCalculation',
        entityId: str(row.id),
        message: 'fee currency differs from linked invoice currency',
        details: { feeCurrency: str(row.fee_currency), invoiceCurrency: str(row.inv_currency) },
      });
    }
  }
}

async function invoiceBasisRebuild(prisma: PrismaClient, organizationId: string, report: ConsistencyReport) {
  const rows = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT i."id", i."invoiceBasisDigest" AS digest, i."status" AS status,
            f."id" AS fee_id, f."feeChainId" AS fee_chain, f."feeAmount"::text AS fee_amount,
            f."currency" AS fee_currency, f."policyRef" AS policy_ref, f."feeBasisVersion" AS basis_version,
            f."membershipDigest" AS membership_digest, c."caseNo" AS case_no
       FROM "BillingInvoice" i
       JOIN "FeeCalculation" f ON f."billingInvoiceId" = i."id"
       JOIN "Case" c ON c."id" = i."caseId"
      WHERE i."organizationId" = $1 AND i."invoiceBasisDigest" IS NOT NULL`,
    organizationId,
  );
  report.checked.INVOICE_BASIS_REBUILD = rows.length;
  for (const row of rows) {
    const rebuilt = computeInvoiceBasis({
      organizationId,
      feeCalculationId: str(row.fee_id),
      feeChainId: row.fee_chain === null ? null : str(row.fee_chain),
      customerAccountIdentity: str(row.case_no),
      currency: str(row.fee_currency),
      feeAmount: str(row.fee_amount),
      policyRef: row.policy_ref === null ? null : str(row.policy_ref),
      feeBasisVersion: row.basis_version === null ? null : str(row.basis_version),
      membershipDigest: row.membership_digest === null ? null : str(row.membership_digest),
    });
    if (rebuilt.digest !== str(row.digest)) {
      report.findings.push({
        code: 'INVOICE_BASIS_REBUILD',
        severity: 'ERROR',
        entityType: 'BillingInvoice',
        entityId: str(row.id),
        message: 'stored invoice basis digest cannot be rebuilt from trusted facts',
        details: { stored: str(row.digest), rebuilt: rebuilt.digest },
      });
    }
  }
}

async function tenantBoundaryCases(prisma: PrismaClient, organizationId: string, report: ConsistencyReport) {
  const rows = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT 'FeeCalculation' AS entity, f."id" AS id FROM "FeeCalculation" f
       JOIN "Case" c ON c."id" = f."caseId"
      WHERE f."organizationId" = $1 AND c."organizationId" <> f."organizationId"
     UNION ALL
     SELECT 'BillingInvoice' AS entity, i."id" AS id FROM "BillingInvoice" i
       JOIN "Case" c ON c."id" = i."caseId"
      WHERE i."organizationId" = $1 AND c."organizationId" <> i."organizationId"
     UNION ALL
     SELECT 'Settlement' AS entity, s."id" AS id FROM "Settlement" s
       JOIN "Case" c ON c."id" = s."caseId"
      WHERE s."organizationId" = $1 AND c."organizationId" <> s."organizationId"`,
    organizationId,
  );
  report.checked.TENANT_BOUNDARY = rows.length;
  for (const row of rows) {
    report.findings.push({
      code: 'TENANT_BOUNDARY',
      severity: 'ERROR',
      entityType: str(row.entity),
      entityId: str(row.id),
      message: 'row references a case owned by another tenant',
    });
  }
}

async function paymentSideEffects(prisma: PrismaClient, organizationId: string, report: ConsistencyReport) {
  const payments = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT "id" FROM "Payment" WHERE "organizationId" = $1`,
    organizationId,
  );
  report.checked.PAYMENT_SIDE_EFFECTS = payments.length;
  for (const row of payments) {
    report.findings.push({
      code: 'PAYMENT_SIDE_EFFECTS',
      severity: 'ERROR',
      entityType: 'Payment',
      entityId: str(row.id),
      message: 'payment row exists while the payment domain is closed',
    });
  }
  const touched = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT "id", "status" AS status, "paidAmount"::text AS paid_amount FROM "BillingInvoice"
      WHERE "organizationId" = $1 AND ("paidAmount" <> 0 OR "paidAt" IS NOT NULL)`,
    organizationId,
  );
  for (const row of touched) {
    report.findings.push({
      code: 'PAYMENT_SIDE_EFFECTS',
      severity: 'ERROR',
      entityType: 'BillingInvoice',
      entityId: str(row.id),
      message: 'invoice carries payment facts while the payment domain is closed',
      details: { status: str(row.status), paidAmount: str(row.paid_amount) },
    });
  }
}

async function orphanReferences(prisma: PrismaClient, organizationId: string, report: ConsistencyReport) {
  const rows = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT 'FeeCalculationSettlement' AS entity, m."id" AS id FROM "FeeCalculationSettlement" m
       LEFT JOIN "Settlement" s ON s."id" = m."settlementId"
      WHERE m."organizationId" = $1 AND m."settlementId" IS NOT NULL AND s."id" IS NULL
     UNION ALL
     SELECT 'FeeCalculationSettlement' AS entity, m."id" AS id FROM "FeeCalculationSettlement" m
       LEFT JOIN "SettlementAdjustment" a ON a."id" = m."adjustmentId"
      WHERE m."organizationId" = $1 AND m."adjustmentId" IS NOT NULL AND a."id" IS NULL
     UNION ALL
     SELECT 'BillingInvoice' AS entity, i."id" AS id FROM "BillingInvoice" i
       LEFT JOIN "Case" c ON c."id" = i."caseId"
      WHERE i."organizationId" = $1 AND i."caseId" IS NOT NULL AND c."id" IS NULL`,
    organizationId,
  );
  report.checked.ORPHAN_REFERENCE = rows.length;
  for (const row of rows) {
    report.findings.push({
      code: 'ORPHAN_REFERENCE',
      severity: 'ERROR',
      entityType: str(row.entity),
      entityId: str(row.id),
      message: 'reference points at a missing parent row',
    });
  }
}

/** 只读运行全部一致性检查（不写任何事实，不触发支付/外写） */
export async function runFinancialChainConsistency(
  prisma: PrismaClient,
  options: { organizationId: string },
): Promise<ConsistencyReport> {
  const report: ConsistencyReport = {
    organizationId: options.organizationId,
    ok: true,
    checked: {
      SETTLEMENT_NET_CHAIN: 0,
      FEE_MEMBERSHIP_CONSISTENCY: 0,
      FEE_ADJUSTMENT_CONSISTENCY: 0,
      FEE_INVOICE_LINKAGE: 0,
      INVOICE_BASIS_REBUILD: 0,
      TENANT_BOUNDARY: 0,
      ORPHAN_REFERENCE: 0,
      PAYMENT_SIDE_EFFECTS: 0,
    },
    findings: [],
  };

  await settlementNetChain(prisma, options.organizationId, report);
  await feeMembershipConsistency(prisma, options.organizationId, report);
  await feeAdjustmentConsistency(prisma, options.organizationId, report);
  await feeInvoiceLinkage(prisma, options.organizationId, report);
  await invoiceBasisRebuild(prisma, options.organizationId, report);
  await tenantBoundaryCases(prisma, options.organizationId, report);
  await orphanReferences(prisma, options.organizationId, report);
  await paymentSideEffects(prisma, options.organizationId, report);

  report.ok = report.findings.length === 0;
  return report;
}
