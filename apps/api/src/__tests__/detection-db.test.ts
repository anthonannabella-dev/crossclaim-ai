/**
 * Wave 2 · C-0004 Checkpoint 1 · Detection Spine（真实 PostgreSQL）
 * ---------------------------------------------------------------
 * 证明（架构方 CHECKPOINT 1 要求）：
 *   1. 金额确定性：INV-1001 应收 135.0000、可追回 17.7500
 *   2. 规则版本可追溯：评估行指向具体 RuleVersion，computed 里带 definitionHash / 中间值
 *   3. 优先级生效：同 lane/service 必须选中 CUSTOMER_RATE_CARD 而不是 CARRIER_TARIFF
 *   4. 幂等：重复执行不新增 RuleEvaluation / RecoveryOpportunity
 *   5. 至少 1 条 PASS（INV-1002，差额 0）
 *   6. 至少 1 条 OPPORTUNITY（INV-1001）
 * 数据全部来自 apps/api/fixtures/logistics（100% 合成）。
 */

import fs from 'node:fs';
import path from 'node:path';

import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { parseCsv } from '../services/ingest';
import {
  createPrismaDetectionRepository,
  runFreightRateDetection,
} from '../services/rules';

const prisma = new PrismaClient();
const repository = createPrismaDetectionRepository(prisma);

const ORG = '33333333-3333-4333-8333-333333333333';
let FIXTURE_ACCOUNT_ID = '';
let FIXTURE_CONNECTION_ID = '';
const fixtures = path.join(__dirname, '..', '..', 'fixtures', 'logistics');

const readJson = (name: string) => JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'));
const rowsOf = (name: string) => {
  const parsed = parseCsv(fs.readFileSync(path.join(fixtures, name), 'utf8'));
  return parsed.rows.map((cells) =>
    Object.fromEntries(parsed.header.map((h, i) => [h, (cells[i] ?? '').trim()])),
  );
};

const expected = readJson('expected-results.json') as {
  rows: Array<{
    invoiceExternalId: string;
    expectedCharge: string;
    actualCharge: string;
    recoverableAmount: string;
    result: string;
  }>;
};
const ruleSeed = readJson('rules.json') as {
  ruleSets: Array<{
    key: string;
    ownerType: 'SYSTEM' | 'TENANT';
    ownerKey: string;
    scope: string;
    name: string;
    description?: string;
    versions: Array<{
      tier: string;
      version: string;
      source: string;
      effectiveFrom: string;
      lastVerified?: string;
      verifiedBy?: string;
      definition: unknown;
    }>;
  }>;
};

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function seedRules(): Promise<void> {
  for (const set of ruleSeed.ruleSets) {
    const created = await prisma.ruleSet.create({
      data: {
        ownerType: set.ownerType,
        // 既有数据库约束 cc_ruleset_ownership_check：
        //   SYSTEM ⇒ organizationId IS NULL 且 ownerKey = 'GLOBAL'
        //   TENANT ⇒ organizationId IS NOT NULL 且 ownerKey = organizationId
        ownerKey: set.ownerType === 'TENANT' ? ORG : 'GLOBAL',
        organizationId: set.ownerType === 'TENANT' ? ORG : null,
        domain: 'LOGISTICS',
        channel: 'OTHER',
        scope: 'FREIGHT_RATE',
        name: set.name,
        description: set.description ?? null,
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
          lastVerified: version.lastVerified ? new Date(version.lastVerified) : null,
          verifiedBy: version.verifiedBy ?? null,
          definition: version.definition as Prisma.InputJsonValue,
        },
      });
    }
  }
}

async function seedTransactions(): Promise<void> {
  const invoices = rowsOf('carrier-invoice.csv');
  const tracking = rowsOf('tracking.csv');

  for (const row of invoices) {
    await prisma.sourceTransaction.create({
      data: {
        organizationId: ORG,
        domain: 'LOGISTICS',
        channel: 'OTHER',
        referenceType: 'INVOICE',
        externalId: row['Invoice No'],
        occurredAt: new Date(`${row['Invoice Date']}T00:00:00Z`),
        amount: new Prisma.Decimal(row['Net Charge']),
        currency: row.Currency,
        accountId: FIXTURE_ACCOUNT_ID,
        connectionId: FIXTURE_CONNECTION_ID,
        dedupeKey: `fixture-invoice-${row['Invoice No']}`,
        raw: row as Prisma.InputJsonValue,
      },
    });
  }
  for (const row of tracking) {
    await prisma.sourceTransaction.create({
      data: {
        organizationId: ORG,
        domain: 'LOGISTICS',
        channel: 'OTHER',
        referenceType: 'TRACKING',
        externalId: row['Tracking Number'],
        occurredAt: new Date(`${row['Pickup Date']}T00:00:00Z`),
        currency: 'USD',
        accountId: FIXTURE_ACCOUNT_ID,
        connectionId: FIXTURE_CONNECTION_ID,
        dedupeKey: `fixture-tracking-${row['Tracking Number']}`,
        raw: row as Prisma.InputJsonValue,
      },
    });
  }
}

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "RuleEvaluation", "RecoveryOpportunity", "RuleVersion", "RuleSet", "CanonicalFactSource", "CanonicalFact", "SourceTransaction", "ImportBatch", "SourceConnection", "PlatformAccount", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: '检测租户', slug: 'detect-org' } });
  // TRACK B BATCH 2：检测链要求事实已归因到 canonical PlatformAccount。
  const account = await prisma.platformAccount.create({
    data: {
      organizationId: ORG,
      platform: 'UPS',
      externalAccountId: 'fixture-' + ORG,
      displayName: 'fixture account',
    },
  });
  const connection = await prisma.sourceConnection.create({
    data: {
      organizationId: ORG,
      domain: 'LOGISTICS',
      channel: 'OTHER',
      kind: 'FILE_UPLOAD',
      status: 'ACTIVE',
      label: 'detection fixture',
      platformAccountId: account.id,
    },
  });
  FIXTURE_ACCOUNT_ID = account.id;
  FIXTURE_CONNECTION_ID = connection.id;
  await seedRules();
  await seedTransactions();
});

describe('C-0004 CP1 · Detection Spine（真实 PostgreSQL）', () => {
  it('产出 1 条 OPPORTUNITY + 4 条 PASS，金额与 fixture 预期完全一致', async () => {
    const run = await runFreightRateDetection({ organizationId: ORG, repository });

    expect(run.invoicesConsidered).toBe(5);
    expect(run.evaluationsCreated).toBe(5);
    expect(run.opportunitiesCreated).toBe(1);

    for (const row of expected.rows) {
      const outcome = run.outcomes.find((o) => o.invoiceExternalId === row.invoiceExternalId);
      expect(outcome, `缺少 ${row.invoiceExternalId} 的检测结果`).toBeDefined();
      expect(outcome!.result).toBe(row.result);
      expect(outcome!.expected).toBe(row.expectedCharge);
      expect(outcome!.actual).toBe(row.actualCharge);
      expect(outcome!.recoverable).toBe(row.recoverableAmount);
    }

    expect(await prisma.ruleEvaluation.count({ where: { organizationId: ORG } })).toBe(5);
    const opportunities = await prisma.recoveryOpportunity.findMany({ where: { organizationId: ORG } });
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0].opportunityType).toBe('FREIGHT_RATE_OVERCHARGE');
    expect(opportunities[0].channel).toBe('OTHER');
    expect(opportunities[0].status).toBe('DETECTED');
    expect(opportunities[0].amountExpected?.toFixed(4)).toBe('135.0000');
    expect(opportunities[0].amountActual?.toFixed(4)).toBe('152.7500');
    expect(opportunities[0].recoverableAmount?.toFixed(4)).toBe('17.7500');
    expect(opportunities[0].currency).toBe('USD');
  });

  it('优先级生效：INV-1001 命中的是 CUSTOMER_RATE_CARD 而不是 CARRIER_TARIFF', async () => {
    const run = await runFreightRateDetection({ organizationId: ORG, repository });
    const inv1001 = run.outcomes.find((o) => o.invoiceExternalId === 'INV-1001')!;
    expect(inv1001.ruleTier).toBe('CUSTOMER_RATE_CARD');

    const invoice = await prisma.sourceTransaction.findFirstOrThrow({
      where: { organizationId: ORG, externalId: 'INV-1001' },
    });
    const linked = await prisma.ruleEvaluation.findFirstOrThrow({
      where: { organizationId: ORG, sourceTransactionId: invoice.id },
      include: { ruleVersion: true },
    });
    expect(linked.ruleVersion.tier).toBe('CUSTOMER_RATE_CARD');
    const computed = linked.computed as { ruleTier: string; definitionHash: string; intermediate: Record<string, string> };
    expect(computed.ruleTier).toBe('CUSTOMER_RATE_CARD');
    expect(computed.definitionHash).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    expect(computed.intermediate.expectedAmount).toBe('135.0000');
    expect(computed.intermediate.recoverableAmount).toBe('17.7500');
    expect(linked.opportunityId).not.toBeNull();
  });

  it('幂等：重复执行不新增 RuleEvaluation / RecoveryOpportunity', async () => {
    const first = await runFreightRateDetection({ organizationId: ORG, repository });
    expect(first.evaluationsCreated).toBe(5);
    const firstInv1001 = first.outcomes.find((o) => o.invoiceExternalId === 'INV-1001')!;
    expect(firstInv1001.result).toBe('OPPORTUNITY');

    const second = await runFreightRateDetection({ organizationId: ORG, repository });
    expect(second.evaluationsCreated).toBe(0);
    expect(second.opportunitiesCreated).toBe(0);
    expect(second.skippedExisting).toBe(5);

    // CHANGE #39：重跑必须返回数据库真实保存的结果，INV-1001 不能变回 PASS，金额必须一致
    const secondInv1001 = second.outcomes.find((o) => o.invoiceExternalId === 'INV-1001')!;
    expect(secondInv1001.result).toBe('OPPORTUNITY');
    expect(secondInv1001.expected).toBe(firstInv1001.expected);
    expect(secondInv1001.recoverable).toBe(firstInv1001.recoverable);
    expect(secondInv1001.opportunityId).toBe(firstInv1001.opportunityId);

    expect(await prisma.ruleEvaluation.count({ where: { organizationId: ORG } })).toBe(5);
    expect(await prisma.recoveryOpportunity.count({ where: { organizationId: ORG } })).toBe(1);
  });

  // CHANGE #39：并发执行同一批数据，唯一键兜底，不能出现重复机会或整轮失败
  it('并发两次检测：结果仍为 5 Evaluation / 1 Opportunity，两次调用均正常结束', async () => {
    const [a, b] = await Promise.all([
      runFreightRateDetection({ organizationId: ORG, repository }),
      runFreightRateDetection({ organizationId: ORG, repository }),
    ]);

    expect(a.invoicesConsidered).toBe(5);
    expect(b.invoicesConsidered).toBe(5);
    expect(await prisma.ruleEvaluation.count({ where: { organizationId: ORG } })).toBe(5);
    expect(await prisma.recoveryOpportunity.count({ where: { organizationId: ORG } })).toBe(1);
  });

  // CHANGE #40：Domain / Channel 隔离——UPS 渠道与其他 domain 的数据必须完全不参与本 slice
  it('Domain/Channel 隔离：UPS 渠道与其他 domain 的账单、轨迹、规则完全不参与', async () => {
    // 干扰 1：UPS 渠道的账单 + 轨迹（同运单号），金额巨大
    await prisma.sourceTransaction.create({
      data: {
        organizationId: ORG, domain: 'LOGISTICS', channel: 'UPS', referenceType: 'INVOICE',
        externalId: 'INV-UPS-1', occurredAt: new Date('2026-09-01T00:00:00Z'),
        amount: new Prisma.Decimal('9999.0000'), currency: 'USD',
        dedupeKey: 'fixture-ups-invoice', raw: { 'Tracking Number': '1ZUPS001' } as Prisma.InputJsonValue,
      },
    });
    await prisma.sourceTransaction.create({
      data: {
        organizationId: ORG, domain: 'LOGISTICS', channel: 'UPS', referenceType: 'TRACKING',
        externalId: '1ZUPS001', occurredAt: new Date('2026-09-01T00:00:00Z'), currency: 'USD',
        dedupeKey: 'fixture-ups-tracking',
        raw: { Lane: 'CN-SHA>US-LAX', Service: 'Ground', 'Weight Kg': '12.5000' } as Prisma.InputJsonValue,
      },
    });
    // 干扰 2：UPS 渠道的费率规则，价格故意更诱人（base 1.0000），若被串用 INV-UPS-1 会变成巨额机会
    const upsSet = await prisma.ruleSet.create({
      data: {
        ownerType: 'SYSTEM', ownerKey: 'GLOBAL', organizationId: null,
        domain: 'LOGISTICS', channel: 'UPS', scope: 'FREIGHT_RATE', name: 'DEMO UPS Tariff',
      },
    });
    await prisma.ruleVersion.create({
      data: {
        ruleSetId: upsSet.id, organizationId: null, tier: 'CARRIER_TARIFF', source: 'fixture-ups',
        version: 'v1-ups', effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        definition: {
          schemaVersion: 1, kind: 'FREIGHT_RATE_V1',
          match: { lane: 'CN-SHA>US-LAX', service: 'Ground' },
          pricing: { currency: 'USD', baseRate: '1.0000', perKg: '0.1000', fuelPct: '1.00' },
        } as Prisma.InputJsonValue,
      },
    });
    // 干扰 3：其他 domain 的 FREIGHT_RATE 规则（CUSTOMS / OTHER），也必须不参与
    const customsSet = await prisma.ruleSet.create({
      data: {
        ownerType: 'SYSTEM', ownerKey: 'GLOBAL', organizationId: null,
        domain: 'CUSTOMS', channel: 'OTHER', scope: 'FREIGHT_RATE', name: 'DEMO Customs Tariff',
      },
    });
    await prisma.ruleVersion.create({
      data: {
        ruleSetId: customsSet.id, organizationId: null, tier: 'CARRIER_TARIFF', source: 'fixture-customs',
        version: 'v1-customs', effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        definition: {
          schemaVersion: 1, kind: 'FREIGHT_RATE_V1',
          match: { lane: 'CN-SHA>US-LAX', service: 'Ground' },
          pricing: { currency: 'USD', baseRate: '2.0000', perKg: '0.2000', fuelPct: '1.00' },
        } as Prisma.InputJsonValue,
      },
    });

    const run = await runFreightRateDetection({ organizationId: ORG, repository });

    // 只处理 OTHER 的 5 张账单；UPS 账单不进入视野
    expect(run.invoicesConsidered).toBe(5);
    expect(run.evaluationsCreated).toBe(5);
    expect(run.opportunitiesCreated).toBe(1);
    expect(run.outcomes.some((o) => o.invoiceExternalId === 'INV-UPS-1')).toBe(false);

    // 库里仍然只有 5 条评估 / 1 条机会（UPS 那张没有被评估）
    expect(await prisma.ruleEvaluation.count({ where: { organizationId: ORG } })).toBe(5);
    const opportunities = await prisma.recoveryOpportunity.findMany({ where: { organizationId: ORG } });
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0].channel).toBe('OTHER');
    expect(opportunities[0].recoverableAmount?.toFixed(4)).toBe('17.7500');
    const upsInvoice = await prisma.sourceTransaction.findFirstOrThrow({
      where: { organizationId: ORG, externalId: 'INV-UPS-1' },
    });
    expect(
      await prisma.ruleEvaluation.count({ where: { organizationId: ORG, sourceTransactionId: upsInvoice.id } }),
    ).toBe(0);
  });

  // CHANGE #42：账单币种与规则币种不一致时不得计算机会
  it('跨币种不计算：EUR 账单 + USD 规则 → NEEDS_MORE_DATA / CURRENCY_MISMATCH', async () => {
    await prisma.sourceTransaction.updateMany({
      where: { organizationId: ORG, externalId: 'INV-1001' },
      data: { currency: 'EUR' },
    });

    const run = await runFreightRateDetection({ organizationId: ORG, repository });
    const inv1001 = run.outcomes.find((o) => o.invoiceExternalId === 'INV-1001')!;
    expect(inv1001.result).toBe('NEEDS_MORE_DATA');
    expect(inv1001.skippedReason).toBe('CURRENCY_MISMATCH');
    expect(inv1001.recoverable).toBeNull();

    expect(await prisma.recoveryOpportunity.count({ where: { organizationId: ORG } })).toBe(0);
    const invoice = await prisma.sourceTransaction.findFirstOrThrow({
      where: { organizationId: ORG, externalId: 'INV-1001' },
    });
    expect(
      await prisma.ruleEvaluation.count({ where: { organizationId: ORG, sourceTransactionId: invoice.id } }),
    ).toBe(0);
  });

  // CHANGE #44：账单缺日期时不得用“现在”选历史规则（否则不可复算）
  it('缺账单日期：MISSING_OCCURRED_AT 且不产生评估/机会，且与执行时刻无关', async () => {
    await prisma.sourceTransaction.updateMany({
      where: { organizationId: ORG, externalId: 'INV-1001' },
      data: { occurredAt: null },
    });

    const first = await runFreightRateDetection({ organizationId: ORG, repository });
    const second = await runFreightRateDetection({ organizationId: ORG, repository });

    for (const run of [first, second]) {
      const inv1001 = run.outcomes.find((o) => o.invoiceExternalId === 'INV-1001')!;
      expect(inv1001.result).toBe('NEEDS_MORE_DATA');
      expect(inv1001.skippedReason).toBe('MISSING_OCCURRED_AT');
      expect(inv1001.recoverable).toBeNull();
    }

    const invoice = await prisma.sourceTransaction.findFirstOrThrow({
      where: { organizationId: ORG, externalId: 'INV-1001' },
    });
    expect(
      await prisma.ruleEvaluation.count({ where: { organizationId: ORG, sourceTransactionId: invoice.id } }),
    ).toBe(0);
    expect(await prisma.recoveryOpportunity.count({ where: { organizationId: ORG } })).toBe(0);
  });

  // CHANGE #45：currency 先参与 applicability，再比 tier —— 存在同币种的低层级规则时必须用它
  it('币种参与适用性：EUR 账单必须命中 EUR CARRIER_TARIFF，而不是被 USD 高层级规则判成 CURRENCY_MISMATCH', async () => {
    const tariffSet = await prisma.ruleSet.create({
      data: {
        ownerType: 'SYSTEM', ownerKey: 'GLOBAL', organizationId: null,
        domain: 'LOGISTICS', channel: 'OTHER', scope: 'FREIGHT_RATE', name: 'DEMO EUR Tariff',
      },
    });
    await prisma.ruleVersion.create({
      data: {
        ruleSetId: tariffSet.id, organizationId: null, tier: 'CARRIER_TARIFF', source: 'fixture-eur-tariff',
        version: 'v1-eur-lax-ground', effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        definition: {
          schemaVersion: 1, kind: 'FREIGHT_RATE_V1',
          match: { lane: 'CN-SHA>US-LAX', service: 'Ground' },
          pricing: { currency: 'EUR', baseRate: '95.0000', perKg: '3.6000', fuelPct: '13.00' },
        } as Prisma.InputJsonValue,
      },
    });
    await prisma.sourceTransaction.updateMany({
      where: { organizationId: ORG, externalId: 'INV-1001' },
      data: { currency: 'EUR' },
    });

    const run = await runFreightRateDetection({ organizationId: ORG, repository });
    const inv1001 = run.outcomes.find((o) => o.invoiceExternalId === 'INV-1001')!;

    // 必须落到 EUR 的 CARRIER_TARIFF（预期应收按 EUR 费率算出），而不是 CURRENCY_MISMATCH
    expect(inv1001.skippedReason).toBeUndefined();
    expect(inv1001.ruleTier).toBe('CARRIER_TARIFF');
    expect(inv1001.expected).toBe('158.2000');
    expect(inv1001.actual).toBe('152.7500');

    const currency = await prisma.ruleEvaluation.findFirstOrThrow({
      where: { organizationId: ORG },
      orderBy: { evaluatedAt: 'desc' },
      include: { ruleVersion: true },
    });
    expect(currency.ruleVersion.tier).toBeDefined();
    const linked = await prisma.sourceTransaction.findFirstOrThrow({
      where: { organizationId: ORG, externalId: 'INV-1001' },
    });
    const evaluation = await prisma.ruleEvaluation.findFirstOrThrow({
      where: { organizationId: ORG, sourceTransactionId: linked.id },
      include: { ruleVersion: true },
    });
    expect(evaluation.ruleVersion.tier).toBe('CARRIER_TARIFF');
    expect(
      (evaluation.computed as { currency: string }).currency,
    ).toBe('EUR');
  });

  // CHANGE #46：同运单号多条轨迹必须 fail closed，且与创建顺序无关
  it('轨迹歧义：同运单号两条事实 → AMBIGUOUS_TRACKING 且不产生评估/机会（与顺序无关）', async () => {
    const trackingRows = await prisma.sourceTransaction.findMany({
      where: { organizationId: ORG, referenceType: 'TRACKING' },
      orderBy: { externalId: 'asc' },
    });
    const first = trackingRows.find((row) => row.externalId === '1ZDEMO001')!;
    const duplicate = {
      organizationId: ORG,
      domain: 'LOGISTICS' as const,
      channel: 'OTHER' as const,
      referenceType: 'TRACKING',
      externalId: '1ZDEMO001',
      occurredAt: new Date('2026-08-25T00:00:00Z'),
      currency: 'USD',
      dedupeKey: 'fixture-tracking-1ZDEMO001-r2',
      raw: { Lane: 'CN-SHA>US-LAX', Service: 'Ground', 'Weight Kg': '12.0000' } as Prisma.InputJsonValue,
    };

    const runOnce = async (createDuplicateFirst: boolean) => {
      await prisma.sourceTransaction.deleteMany({
        where: { organizationId: ORG, referenceType: 'TRACKING' },
      });
      if (createDuplicateFirst) {
        await prisma.sourceTransaction.create({ data: duplicate });
        await prisma.sourceTransaction.create({
          data: {
            organizationId: ORG, domain: 'LOGISTICS', channel: 'OTHER', referenceType: 'TRACKING',
            externalId: first.externalId!, occurredAt: first.occurredAt, currency: 'USD',
            dedupeKey: first.dedupeKey,
            raw: first.raw as Prisma.InputJsonValue,
          },
        });
      } else {
        await prisma.sourceTransaction.create({
          data: {
            organizationId: ORG, domain: 'LOGISTICS', channel: 'OTHER', referenceType: 'TRACKING',
            externalId: first.externalId!, occurredAt: first.occurredAt, currency: 'USD',
            dedupeKey: first.dedupeKey,
            raw: first.raw as Prisma.InputJsonValue,
          },
        });
        await prisma.sourceTransaction.create({ data: duplicate });
      }
      return runFreightRateDetection({ organizationId: ORG, repository });
    };

    const runA = await runOnce(false);
    const invA = runA.outcomes.find((o) => o.invoiceExternalId === 'INV-1001')!;
    expect(invA.result).toBe('NEEDS_MORE_DATA');
    expect(invA.skippedReason).toBe('AMBIGUOUS_TRACKING');

    // 清掉本轮产生的评估，交换插入顺序再跑一次，结果必须一致
    await prisma.ruleEvaluation.deleteMany({ where: { organizationId: ORG } });
    await prisma.recoveryOpportunity.deleteMany({ where: { organizationId: ORG } });
    const runB = await runOnce(true);
    const invB = runB.outcomes.find((o) => o.invoiceExternalId === 'INV-1001')!;
    expect(invB.result).toBe('NEEDS_MORE_DATA');
    expect(invB.skippedReason).toBe('AMBIGUOUS_TRACKING');

    const invoice = await prisma.sourceTransaction.findFirstOrThrow({
      where: { organizationId: ORG, externalId: 'INV-1001' },
    });
    expect(
      await prisma.ruleEvaluation.count({ where: { organizationId: ORG, sourceTransactionId: invoice.id } }),
    ).toBe(0);
    expect(await prisma.recoveryOpportunity.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it('缺少轨迹时不产出评估：记为 NEEDS_MORE_DATA，不写 RuleEvaluation', async () => {
    await prisma.sourceTransaction.deleteMany({
      where: { organizationId: ORG, referenceType: 'TRACKING', externalId: '1ZDEMO001' },
    });

    const run = await runFreightRateDetection({ organizationId: ORG, repository });
    const inv1001 = run.outcomes.find((o) => o.invoiceExternalId === 'INV-1001')!;
    expect(inv1001.result).toBe('NEEDS_MORE_DATA');
    expect(inv1001.skippedReason).toBe('TRACKING_NOT_FOUND');

    const invoice = await prisma.sourceTransaction.findFirstOrThrow({
      where: { organizationId: ORG, externalId: 'INV-1001' },
    });
    expect(
      await prisma.ruleEvaluation.count({ where: { organizationId: ORG, sourceTransactionId: invoice.id } }),
    ).toBe(0);
    expect(await prisma.recoveryOpportunity.count({ where: { organizationId: ORG } })).toBe(0);
  });
});
