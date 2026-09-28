/**
 * Wave 2 · C-0004 Checkpoint 2 · Recovery Closure（真实 PostgreSQL）
 * ---------------------------------------------------------------
 * 证明（架构方 CHECKPOINT 2 要求）：
 *   1. Opportunity → Case(+CaseOpportunity) → RecoveryRoute(CARRIER) → 3×Evidence/CaseEvidence → Claim DRAFT
 *   2. Case/Claim 状态跃迁写 AuditLog（case.status_changed / claim.created / claim.status_changed）
 *   3. 仅 test/demo 合成 Settlement RECEIVED；只有它之后才写 Ledger（金额取自 Settlement，禁 SourceTransaction→Ledger 直连）
 *   4. 费率来自数据（commercial-terms.json），Decimal 计算：17.7500 × 0.1500 = 2.6625；Billing 只到 DRAFT
 *   5. 整链重复跑不新增第二份 Case/Claim/Settlement/Ledger/Fee/Billing
 */

import fs from 'node:fs';
import path from 'node:path';

import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { parseCsv } from '../services/ingest';
import { runRecoveryClosure } from '../services/recovery';
import { createPrismaDetectionRepository, runFreightRateDetection } from '../services/rules';

const prisma = new PrismaClient();
const ORG = '44444444-4444-4444-8444-444444444444';
const fixtures = path.join(__dirname, '..', '..', 'fixtures', 'logistics');

const readJson = (name: string) => JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'));
const rowsOf = (name: string) => {
  const parsed = parseCsv(fs.readFileSync(path.join(fixtures, name), 'utf8'));
  return parsed.rows.map((cells) =>
    Object.fromEntries(parsed.header.map((h, i) => [h, (cells[i] ?? '').trim()])),
  );
};

const terms = readJson('commercial-terms.json') as {
  terms: Array<{ successFeeRate: string; source: string }>;
};

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "FeeCalculation", "BillingInvoice", "RecoveryLedgerEntry", "Settlement", "Claim", "CaseEvidence", "EvidenceArtifact", "RecoveryRoute", "CaseOpportunity", "Case", "RuleEvaluation", "RecoveryOpportunity", "RuleVersion", "RuleSet", "SourceTransaction", "ImportBatch", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: '闭环租户', slug: 'closure-org' } });

  const ruleSeed = readJson('rules.json') as {
    ruleSets: Array<{
      ownerType: 'SYSTEM' | 'TENANT';
      scope: string;
      name: string;
      versions: Array<{ tier: string; version: string; source: string; effectiveFrom: string; definition: unknown }>;
    }>;
  };
  for (const set of ruleSeed.ruleSets) {
    const created = await prisma.ruleSet.create({
      data: {
        ownerType: set.ownerType,
        ownerKey: set.ownerType === 'TENANT' ? ORG : 'GLOBAL',
        organizationId: set.ownerType === 'TENANT' ? ORG : null,
        domain: 'LOGISTICS',
        channel: 'OTHER',
        scope: 'FREIGHT_RATE',
        name: set.name,
      },
    });
    for (const version of set.versions) {
      await prisma.ruleVersion.create({
        data: {
          ruleSetId: created.id,
          organizationId: set.ownerType === 'TENANT' ? ORG : null,
          tier: version.tier as Prisma.RuleVersionCreateInput['tier'],
          source: version.source,
          version: version.version,
          effectiveFrom: new Date(version.effectiveFrom),
          definition: version.definition as Prisma.InputJsonValue,
        },
      });
    }
  }

  for (const row of rowsOf('carrier-invoice.csv')) {
    await prisma.sourceTransaction.create({
      data: {
        organizationId: ORG, domain: 'LOGISTICS', channel: 'OTHER', referenceType: 'INVOICE',
        externalId: row['Invoice No'], occurredAt: new Date(`${row['Invoice Date']}T00:00:00Z`),
        amount: new Prisma.Decimal(row['Net Charge']), currency: row.Currency,
        dedupeKey: `closure-invoice-${row['Invoice No']}`, raw: row as Prisma.InputJsonValue,
      },
    });
  }
  for (const row of rowsOf('tracking.csv')) {
    await prisma.sourceTransaction.create({
      data: {
        organizationId: ORG, domain: 'LOGISTICS', channel: 'OTHER', referenceType: 'TRACKING',
        externalId: row['Tracking Number'], occurredAt: new Date(`${row['Pickup Date']}T00:00:00Z`),
        currency: 'USD', dedupeKey: `closure-tracking-${row['Tracking Number']}`,
        raw: row as Prisma.InputJsonValue,
      },
    });
  }

  await runFreightRateDetection({
    organizationId: ORG,
    repository: createPrismaDetectionRepository(prisma),
  });

  // CHANGE #47：人工确认模拟 —— 检测产出的 DETECTED 不会被闭环自动处理，
  // 测试准备阶段显式推进到 QUALIFIED 并留审计（Closure Service 本身不做这一步）。
  const detected = await prisma.recoveryOpportunity.findMany({ where: { organizationId: ORG, status: 'DETECTED' } });
  for (const opportunity of detected) {
    await prisma.recoveryOpportunity.update({ where: { id: opportunity.id }, data: { status: 'QUALIFIED' } });
    await prisma.auditLog.create({
      data: {
        organizationId: ORG,
        actorType: 'SYSTEM',
        actorRef: 'test-setup-manual-qualification',
        action: 'opportunity.status_changed',
        entityType: 'RecoveryOpportunity',
        entityId: opportunity.id,
        changes: { from: 'DETECTED', to: 'QUALIFIED' },
      },
    });
  }
});

const closure = () =>
  runRecoveryClosure({
    organizationId: ORG,
    prisma,
    commercialTerms: { successFeeRate: terms.terms[0].successFeeRate, source: terms.terms[0].source },
    simulateSettlement: true,
  });

describe('C-0004 CP2 · Recovery Closure（真实 PostgreSQL）', () => {
  it('闭环产出 Case/Route/Evidence/Claim DRAFT + 合成 Settlement → Ledger → Fee 2.6625 → Billing DRAFT', async () => {
    const run = await closure();

    expect(run.casesCreated).toBe(1);
    expect(run.claimsCreated).toBe(1);
    // 3 份索赔前证据（INVOICE / RATE_CARD / TRACKING）+ 1 份到账证据（CREDIT_NOTE）
    expect(run.evidenceCreated).toBe(4);
    expect(run.settlementsCreated).toBe(1);
    expect(run.ledgerEntriesCreated).toBe(1);
    expect(run.feeCalculationsCreated).toBe(1);
    expect(run.billingInvoicesCreated).toBe(1);

    const kase = await prisma.case.findFirstOrThrow({ where: { organizationId: ORG } });
    expect(kase.claimedAmount?.toFixed(4)).toBe('17.7500');
    expect(kase.currency).toBe('USD');

    const claim = await prisma.claim.findFirstOrThrow({ where: { organizationId: ORG } });
    // CHANGE #48：simulateSettlement=true 是 test/demo 生命周期模拟，必须走到 APPROVED
    expect(claim.status).toBe('APPROVED');
    expect(claim.target).toBe('CARRIER');
    expect(claim.aiDraftText).toContain('17.7500');

    // CHANGE #48：到账案件不能停留在 OPEN，必须推进到 SETTLED
    expect(kase.status).toBe('SETTLED');
    const caseAudits = await prisma.auditLog.findMany({
      where: { organizationId: ORG, entityType: 'Case', entityId: kase.id },
    });
    const caseFlow = caseAudits.map((row) => `${(row.changes as { from: string }).from}->${(row.changes as { to: string }).to}`);
    expect(caseFlow).toEqual(
      expect.arrayContaining(['OPEN->COLLECTING_EVIDENCE', 'COLLECTING_EVIDENCE->READY_TO_CLAIM', 'READY_TO_CLAIM->CLAIMED', 'CLAIMED->WON', 'WON->SETTLED']),
    );
    const claimAudits = await prisma.auditLog.findMany({
      where: { organizationId: ORG, entityType: 'Claim' },
    });
    const claimFlow = claimAudits.map((row) => `${(row.changes as { from: string }).from}->${(row.changes as { to: string }).to}`);
    expect(claimFlow).toEqual(
      expect.arrayContaining(['DRAFT->SUBMITTED', 'SUBMITTED->ACKNOWLEDGED', 'ACKNOWLEDGED->APPROVED']),
    );

    const route = await prisma.recoveryRoute.findFirstOrThrow({ where: { organizationId: ORG } });
    expect(route.target).toBe('CARRIER');
    expect(route.status).toBe('PROPOSED');

    // 3 份索赔前证据 + 1 份到账证据（CREDIT_NOTE）
    expect(await prisma.caseEvidence.count({ where: { organizationId: ORG, caseId: kase.id } })).toBe(4);
    expect(await prisma.caseOpportunity.count({ where: { organizationId: ORG, caseId: kase.id } })).toBe(1);

    const settlement = await prisma.settlement.findFirstOrThrow({ where: { organizationId: ORG, caseId: kase.id } });
    expect(settlement.status).toBe('RECEIVED');
    expect(settlement.amount.toFixed(4)).toBe('17.7500');
    // CHANGE #49：到账必须挂 CREDIT_NOTE 到账证据，且该证据也挂在案件上
    expect(settlement.evidenceId).not.toBeNull();
    const credit = await prisma.evidenceArtifact.findUniqueOrThrow({ where: { id: settlement.evidenceId! } });
    expect(credit.kind).toBe('CREDIT_NOTE');
    expect(credit.organizationId).toBe(ORG);
    expect(
      await prisma.caseEvidence.count({ where: { organizationId: ORG, caseId: kase.id, evidenceId: credit.id } }),
    ).toBe(1);

    const ledger = await prisma.recoveryLedgerEntry.findMany({ where: { organizationId: ORG } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0].entryType).toBe('RECOVERED');
    expect(ledger[0].amount.toFixed(4)).toBe('17.7500');
    // 账本金额必须来自 Settlement（禁止 SourceTransaction → Ledger 直连）
    expect(ledger[0].settlementId).toBe(settlement.id);
    expect(ledger.every((entry) => entry.settlementId !== null)).toBe(true);

    const fee = await prisma.feeCalculation.findFirstOrThrow({ where: { organizationId: ORG } });
    expect(fee.basis).toBe('RECOVERED_AMOUNT_PCT');
    expect(fee.baseAmount.toFixed(4)).toBe('17.7500');
    expect(fee.rate?.toFixed(6)).toBe('0.150000');
    expect(fee.feeAmount.toFixed(4)).toBe('2.6625');
    expect((fee.computation as { source: string }).source).toBe('fixtures/logistics/commercial-terms.json');

    const invoice = await prisma.billingInvoice.findFirstOrThrow({ where: { organizationId: ORG } });
    expect(invoice.status).toBe('DRAFT');
    expect(invoice.total.toFixed(4)).toBe('2.6625');
    expect(invoice.caseId).toBe(kase.id);

    const auditActions = (await prisma.auditLog.findMany({ where: { organizationId: ORG } })).map((row) => row.action);
    expect(auditActions).toContain('case.status_changed');
    expect(auditActions).toContain('claim.created');
    expect(auditActions).toContain('claim.status_changed');
  });

  it('幂等：第二次闭环不新增 Case/Claim/Settlement/Ledger/Fee/Billing', async () => {
    await closure();
    const second = await closure();

    expect(second.casesCreated).toBe(0);
    expect(second.casesReused).toBe(1);
    expect(second.claimsCreated).toBe(0);
    expect(second.settlementsCreated).toBe(0);
    expect(second.ledgerEntriesCreated).toBe(0);
    expect(second.feeCalculationsCreated).toBe(0);
    expect(second.billingInvoicesCreated).toBe(0);

    expect(await prisma.case.count({ where: { organizationId: ORG } })).toBe(1);
    expect(await prisma.claim.count({ where: { organizationId: ORG } })).toBe(1);
    expect(await prisma.settlement.count({ where: { organizationId: ORG } })).toBe(1);
    expect(await prisma.recoveryLedgerEntry.count({ where: { organizationId: ORG } })).toBe(1);
    expect(await prisma.feeCalculation.count({ where: { organizationId: ORG } })).toBe(1);
    expect(await prisma.billingInvoice.count({ where: { organizationId: ORG } })).toBe(1);
  });

  it('资金方向分离：Case.recoveredAmount 来自 Settlement；Billing 属于 CrossClaim 且不是 PAID', async () => {
    await closure();
    const kase = await prisma.case.findFirstOrThrow({ where: { organizationId: ORG } });
    expect(kase.recoveredAmount.toFixed(4)).toBe('17.7500');

    const invoice = await prisma.billingInvoice.findFirstOrThrow({ where: { organizationId: ORG } });
    expect(invoice.status).not.toBe('PAID');
    expect(invoice.paidAt).toBeNull();
    expect(invoice.total.toFixed(4)).not.toBe(kase.recoveredAmount.toFixed(4));
  });

  // CHANGE #47：普通 DETECTED 不得被闭环自动处理（人工卡口）
  it('DETECTED 不被自动处理：不会建 Case/Claim，状态保持 DETECTED', async () => {
    const detected = await prisma.recoveryOpportunity.findFirstOrThrow({ where: { organizationId: ORG } });
    await prisma.recoveryOpportunity.update({ where: { id: detected.id }, data: { status: 'DETECTED' } });
    await prisma.case.deleteMany({ where: { organizationId: ORG } });

    const run = await closure();
    expect(run.opportunitiesConsidered).toBe(0);
    expect(await prisma.case.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await prisma.claim.count({ where: { organizationId: ORG } })).toBe(0);
    const after = await prisma.recoveryOpportunity.findUniqueOrThrow({ where: { id: detected.id } });
    expect(after.status).toBe('DETECTED');
  });

  // CHANGE #48：不模拟到账时，Phase 1 半自动边界必须停在 READY_TO_CLAIM + DRAFT
  it('不模拟到账：Case=READY_TO_CLAIM、Claim=DRAFT，且 Settlement/Ledger/Fee/Billing 全为 0', async () => {
    const run = await runRecoveryClosure({
      organizationId: ORG,
      prisma,
      commercialTerms: { successFeeRate: terms.terms[0].successFeeRate, source: terms.terms[0].source },
      simulateSettlement: false,
    });
    expect(run.casesCreated).toBe(1);

    const kase = await prisma.case.findFirstOrThrow({ where: { organizationId: ORG } });
    expect(kase.status).toBe('READY_TO_CLAIM');
    const claim = await prisma.claim.findFirstOrThrow({ where: { organizationId: ORG } });
    expect(claim.status).toBe('DRAFT');

    expect(await prisma.settlement.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await prisma.recoveryLedgerEntry.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await prisma.feeCalculation.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await prisma.billingInvoice.count({ where: { organizationId: ORG } })).toBe(0);
  });
});
