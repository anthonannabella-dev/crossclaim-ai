/**
 * 租户隔离与幂等 —— **数据库级**测试（真实 PostgreSQL）
 * ---------------------------------------------------------------
 * 这些断言无法用 schema 文本检查证明，必须打到真实数据库：
 *   1. 同租户关系正常建立
 *   2. 跨租户关系被数据库触发器拒绝
 *   3. 重复导入被唯一键挡住（幂等）
 *   4. Settlement → FeeCalculation → BillingInvoice 可追溯
 *
 * 前置：DATABASE_URL 指向一个已执行 `prisma migrate deploy` 的 PostgreSQL。
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const prisma = new PrismaClient();

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

const BUSINESS_TABLES = [
  'RecoveryLedgerEntry',
  'FeeCalculation',
  'BillingInvoice',
  'Settlement',
  'Appeal',
  'Claim',
  'RecoveryRoute',
  'CaseOpportunity',
  'CaseEvidence',
  'RuleEvaluation',
  'RuleVersion',
  'RuleSet',
  'EvidenceEdge',
  'EvidenceArtifact',
  'RecoveryGraphEdge',
  'RecoveryGraphNode',
  'Case',
  'RecoveryOpportunity',
  'SourceTransaction',
  'ImportBatch',
  'FileAsset',
  'SourceConnection',
  'Membership',
  'AuditLog',
  'User',
  'Organization',
];

async function resetDb() {
  const list = BUSINESS_TABLES.map((t) => `"${t}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} CASCADE;`);
}

async function seedOrgs() {
  await prisma.organization.createMany({
    data: [
      { id: ORG_A, name: '租户 A', slug: 'org-a' },
      { id: ORG_B, name: '租户 B', slug: 'org-b' },
    ],
  });
}

async function makeCase(orgId: string, caseNo: string) {
  return prisma.case.create({
    data: {
      organizationId: orgId,
      caseNo,
      title: `案件 ${caseNo}`,
      domain: 'LOGISTICS',
    },
  });
}

async function makeEvidence(orgId: string, title: string) {
  return prisma.evidenceArtifact.create({
    data: { organizationId: orgId, kind: 'CONTRACT', title },
  });
}

async function makeNode(orgId: string, label: string) {
  return prisma.recoveryGraphNode.create({
    data: { organizationId: orgId, nodeType: 'CASE', label },
  });
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb();
  await seedOrgs();
});

// ============================================================
describe('同租户关系正常建立（基线）', () => {
  it('Case ↔ Evidence 可建立多对多关联', async () => {
    const c = await makeCase(ORG_A, 'A-001');
    const e = await makeEvidence(ORG_A, '合同 A');

    await prisma.caseEvidence.create({
      data: { organizationId: ORG_A, caseId: c.id, evidenceId: e.id, role: 'rate_basis' },
    });

    const links = await prisma.caseEvidence.findMany({ where: { caseId: c.id } });
    expect(links).toHaveLength(1);
  });

  it('同一份证据可服务多个案件（§七.8）', async () => {
    const e = await makeEvidence(ORG_A, '共用费率表');
    const c1 = await makeCase(ORG_A, 'A-101');
    const c2 = await makeCase(ORG_A, 'A-102');

    await prisma.caseEvidence.createMany({
      data: [
        { organizationId: ORG_A, caseId: c1.id, evidenceId: e.id },
        { organizationId: ORG_A, caseId: c2.id, evidenceId: e.id },
      ],
    });

    expect(await prisma.caseEvidence.count({ where: { evidenceId: e.id } })).toBe(2);
  });
});

// ============================================================
describe('跨租户关系必须被数据库拒绝（C-0002 CHANGE #3）', () => {
  it('跨租户 Case ↔ Evidence 建立失败', async () => {
    const c = await makeCase(ORG_A, 'A-201');
    const foreignEvidence = await makeEvidence(ORG_B, '别的租户的合同');

    await expect(
      prisma.caseEvidence.create({
        data: { organizationId: ORG_A, caseId: c.id, evidenceId: foreignEvidence.id },
      }),
    ).rejects.toThrow(/cross-tenant|check_violation|violates/i);
  });

  it('跨租户 GraphEdge 建立失败', async () => {
    const nA = await makeNode(ORG_A, 'A 节点');
    const nB = await makeNode(ORG_B, 'B 节点');

    await expect(
      prisma.recoveryGraphEdge.create({
        data: {
          organizationId: ORG_A,
          fromNodeId: nA.id,
          toNodeId: nB.id,
          edgeType: 'CAUSES',
        },
      }),
    ).rejects.toThrow(/cross-tenant|check_violation|violates/i);
  });

  it('跨租户 RuleEvaluation（引用别租户 Opportunity）建立失败', async () => {
    const rs = await prisma.ruleSet.create({
      data: {
        ownerType: 'TENANT',
        ownerKey: ORG_A,
        organizationId: ORG_A,
        domain: 'LOGISTICS',
        channel: 'UPS',
        scope: 'FREIGHT_RATE',
        name: 'UPS 费率规则',
      },
    });
    const rv = await prisma.ruleVersion.create({
      data: {
        ruleSetId: rs.id,
        organizationId: ORG_A,
        tier: 'CUSTOMER_RATE_CARD',
        source: '客户 Rate Card 2026',
        version: '2026.03',
        effectiveFrom: new Date('2026-03-01'),
        definition: { op: 'compare', field: 'netCharge' },
      },
    });

    const foreignOpp = await prisma.recoveryOpportunity.create({
      data: {
        organizationId: ORG_B,
        domain: 'LOGISTICS',
        channel: 'UPS',
        opportunityType: 'FUEL_SURCHARGE_MISBILL',
        title: 'B 租户的机会',
      },
    });

    await expect(
      prisma.ruleEvaluation.create({
        data: {
          organizationId: ORG_A,
          ruleVersionId: rv.id,
          opportunityId: foreignOpp.id,
          result: 'OPPORTUNITY',
          computed: { diff: 12.3 },
        },
      }),
    ).rejects.toThrow(/cross-tenant|check_violation|violates/i);
  });

  it('跨租户 FeeCalculation（引用别租户 Settlement）建立失败', async () => {
    const foreignSettlement = await prisma.settlement.create({
      data: {
        organizationId: ORG_B,
        source: 'CARRIER_CREDIT',
        amount: 100,
        status: 'RECEIVED',
        receivedAt: new Date(),
      },
    });

    await expect(
      prisma.feeCalculation.create({
        data: {
          organizationId: ORG_A,
          settlementId: foreignSettlement.id,
          basis: 'RECOVERED_AMOUNT_PCT',
          rate: 0.18,
          baseAmount: 100,
          feeAmount: 18,
          computation: { rate: 0.18, base: 100 },
        },
      }),
    ).rejects.toThrow(/cross-tenant|check_violation|violates/i);
  });
});

// ============================================================
describe('原始交易幂等（C-0002 CHANGE #6）', () => {
  const dedupeKey = 'sha256:same-invoice-row';

  it('同一租户重复导入同一 dedupeKey 被唯一键挡住', async () => {
    await prisma.sourceTransaction.create({
      data: {
        organizationId: ORG_A,
        domain: 'LOGISTICS',
        channel: 'UPS',
        externalId: 'INV-1001',
        referenceType: 'INVOICE',
        dedupeKey,
        amount: 120.5,
        raw: { row: 1 },
      },
    });

    await expect(
      prisma.sourceTransaction.create({
        data: {
          organizationId: ORG_A,
          domain: 'LOGISTICS',
          channel: 'UPS',
          externalId: 'INV-1001',
          referenceType: 'INVOICE',
          dedupeKey,
          amount: 120.5,
          raw: { row: 1 },
        },
      }),
    ).rejects.toThrow(/unique|P2002/i);

    expect(await prisma.sourceTransaction.count({ where: { organizationId: ORG_A } })).toBe(1);
  });

  it('不同租户可以有相同 dedupeKey（隔离正确）', async () => {
    const base = {
      domain: 'LOGISTICS' as const,
      channel: 'UPS' as const,
      externalId: 'INV-2002',
      referenceType: 'INVOICE',
      dedupeKey,
      amount: 88,
      raw: { row: 1 },
    };
    await prisma.sourceTransaction.create({ data: { ...base, organizationId: ORG_A } });
    await prisma.sourceTransaction.create({ data: { ...base, organizationId: ORG_B } });

    expect(await prisma.sourceTransaction.count()).toBe(2);
  });
});

// ============================================================
describe('到账可追溯（C-0002 CHANGE #4 / #5）', () => {
  it('Settlement 关联到 Evidence，并可串上 FeeCalculation → BillingInvoice', async () => {
    const c = await makeCase(ORG_A, 'A-301');
    const evidence = await makeEvidence(ORG_A, '承运商 Credit Note');

    const settlement = await prisma.settlement.create({
      data: {
        organizationId: ORG_A,
        caseId: c.id,
        evidenceId: evidence.id,
        source: 'CARRIER_CREDIT',
        amount: 500,
        status: 'RECEIVED',
        receivedAt: new Date(),
      },
    });

    const invoice = await prisma.billingInvoice.create({
      data: {
        organizationId: ORG_A,
        caseId: c.id,
        invoiceNo: 'CC-2026-0001',
        subtotal: 90,
        total: 90,
        status: 'ISSUED',
        issuedAt: new Date(),
      },
    });

    const fee = await prisma.feeCalculation.create({
      data: {
        organizationId: ORG_A,
        settlementId: settlement.id,
        billingInvoiceId: invoice.id,
        caseId: c.id,
        basis: 'RECOVERED_AMOUNT_PCT',
        rate: 0.18,
        baseAmount: 500,
        feeAmount: 90,
        computation: { rate: 0.18, base: 500, note: '成功费' },
      },
    });

    // 从 Settlement 出发应能追到 Fee 与 Invoice
    const traced = await prisma.feeCalculation.findUnique({
      where: { id: fee.id },
      include: { settlement: true, billingInvoice: true, case: true },
    });

    expect(traced?.settlement?.id).toBe(settlement.id);
    expect(traced?.billingInvoice?.invoiceNo).toBe('CC-2026-0001');
    expect(traced?.case?.caseNo).toBe('A-301');
    expect(Number(traced?.feeAmount)).toBe(90);
  });
});

// ============================================================
describe('账本只增不改（REVERSAL 纠错）', () => {
  it('作废用反向分录表达，原条目保留', async () => {
    const c = await makeCase(ORG_A, 'A-401');

    const original = await prisma.recoveryLedgerEntry.create({
      data: {
        organizationId: ORG_A,
        caseId: c.id,
        entryType: 'RECOVERED',
        amount: 300,
        counterparty: 'UPS',
      },
    });

    const reversal = await prisma.recoveryLedgerEntry.create({
      data: {
        organizationId: ORG_A,
        caseId: c.id,
        entryType: 'REVERSAL',
        amount: -300,
        voidsEntryId: original.id,
        voidReason: '重复记账',
      },
    });

    const entries = await prisma.recoveryLedgerEntry.findMany({
      where: { caseId: c.id },
      orderBy: { createdAt: 'asc' },
    });

    expect(entries).toHaveLength(2); // 原条目没有被删改
    expect(Number(entries[0].amount)).toBe(300);
    expect(entries[1].entryType).toBe('REVERSAL');
    expect(Number(entries[1].amount)).toBe(-300);
    expect(entries[1].voidsEntryId).toBe(reversal.voidsEntryId);
  });
});
