/**
 * C-0006-B2 Step 2 — dual write, backfill apply and identity parity.
 * ---------------------------------------------------------------
 * Approved Step 2 asks for:
 *   - dual-write implementation (new evaluations carry the fact identity)
 *   - backfill apply evidence
 *   - two identity parity runs with zero unexpected delta
 *   - old/new dedupeKey consistency
 *   - coverage of newly written evaluations (no silent fallback)
 *   - final unmapped statistics
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  applyIdentityBackfill,
  buildDuplicateResolutionReport,
  buildIdentityParityReport,
  planIdentityBackfill,
} from '../services/canonical';
import {
  createPrismaFileAssetPort,
  createPrismaSourceConnectionPort,
  uploadFileAndImport,
} from '../services/acquisition';
import { createAuditWriter, createPrismaAuditSink } from '../services/audit';
import { createPrismaImportRepository } from '../services/ingest';
import { createPrismaDetectionRepository, runFreightRateDetection } from '../services/rules';
import { LocalFileSystemStorage } from '../services/storage';

const prisma = new PrismaClient();
const ORG = 'd0000000-0000-4000-8000-000000000001';
const SALT = 'gate4-step2-audit-salt-0123456789';
const SCOPE = { domain: 'LOGISTICS', channel: 'OTHER' } as const;
const fixtures = path.join(__dirname, '..', '..', 'fixtures', 'logistics');

const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-step2-'));
const storage = new LocalFileSystemStorage({
  rootDir: storageRoot,
  secret: SALT,
  publicBaseUrl: 'http://localhost:3000',
});

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const imports = createPrismaImportRepository(prisma, { audit });
const connections = createPrismaSourceConnectionPort(prisma);
const fileAssets = createPrismaFileAssetPort(prisma);
const detection = createPrismaDetectionRepository(prisma);

let connectionId = '';

const INVOICE_CSV = [
  'Invoice No,Reference Type,Tracking Number,Invoice Date,Net Charge,Currency',
  'INV-1001,INVOICE,1ZDEMO001,2026-09-01,152.7500,USD',
  'INV-1002,INVOICE,1ZDEMO002,2026-09-01,140.0000,USD',
].join('\n');

const TRACKING_CSV = [
  'Tracking Number,Reference Type,Lane,Service,Weight Kg,Amount,Currency',
  '1ZDEMO001,TRACKING,CN-SHA>US-LAX,Ground,12.5000,0.0000,USD',
  '1ZDEMO002,TRACKING,CN-SHA>US-LAX,Ground,12.5000,0.0000,USD',
].join('\n');

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

async function seedRules(): Promise<void> {
  const seed = JSON.parse(fs.readFileSync(path.join(fixtures, 'rules.json'), 'utf8')) as {
    ruleSets: Array<{
      ownerType: 'SYSTEM' | 'TENANT';
      name: string;
      versions: Array<{ tier: string; version: string; source: string; effectiveFrom: string; definition: unknown }>;
    }>;
  };
  for (const set of seed.ruleSets) {
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
}

async function importCsv(body: string, name: string): Promise<void> {
  const result = await uploadFileAndImport(
    {
      organizationId: ORG,
      connectionId,
      domain: 'LOGISTICS',
      channel: 'OTHER',
      kind: 'CSV',
      originalName: name,
      body: Buffer.from(body, 'utf8'),
    },
    { connections, fileAssets, storage, imports, audit },
  );
  expect(result.import.status).toBe('IMPORTED');
}

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "RuleEvaluationShadow", "CanonicalFactSource", "CanonicalFact", "RuleEvaluation", "RecoveryOpportunity", "Case", "Claim", "Settlement", "RuleVersion", "RuleSet", "SourceTransaction", "ImportBatch", "FileAsset", "SourceConnection", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: '双写租户', slug: 'step2-org' } });
  const connection = await prisma.sourceConnection.create({
    data: {
      organizationId: ORG,
      domain: 'LOGISTICS',
      channel: 'OTHER',
      kind: 'FILE_UPLOAD',
      status: 'ACTIVE',
      label: 'step2 upload',
    },
  });
  connectionId = connection.id;

  await seedRules();
  await importCsv(INVOICE_CSV, 'invoice.csv');
  await importCsv(TRACKING_CSV, 'tracking.csv');
});

const detect = () =>
  runFreightRateDetection({ organizationId: ORG, scope: SCOPE, repository: detection });

describe('C-0006-B2 Step 2 — dual write + identity parity（真实 PostgreSQL）', () => {
  it('新写入的评估 100% 带业务事实身份；两轮 parity report 一致且零意外增量', async () => {
    const run1 = await detect();
    expect(run1.evaluationsCreated).toBe(2);
    expect(run1.evaluationsWithoutCanonicalIdentity).toBe(0);

    const parity1 = await buildIdentityParityReport(prisma, { organizationId: ORG });
    expect(parity1.scanned).toBe(2);
    expect(parity1.withCanonicalIdentity).toBe(2);
    expect(parity1.withoutCanonicalIdentity).toBe(0);
    expect(parity1.coverageRate).toBe('1.0000');
    expect(parity1.duplicateCanonicalIdentities).toHaveLength(0);
    expect(parity1.factLinkMismatches).toHaveLength(0);
    expect(parity1.parity).toBe('OK');

    const rows = await prisma.ruleEvaluation.findMany({ where: { organizationId: ORG } });
    for (const row of rows) {
      expect(row.dedupeKey).not.toBeNull();
      expect(row.canonicalFactId).not.toBeNull();
      expect(row.canonicalDedupeKey).not.toBeNull();
      expect(row.canonicalDedupeKey).toMatch(/^[0-9a-f]{64}$/);
    }

    // Run #2：重复执行必须零意外增量（幂等），parity 仍然 OK
    const run2 = await detect();
    expect(run2.evaluationsCreated).toBe(0);
    expect(run2.skippedExisting).toBe(2);
    expect(await prisma.ruleEvaluation.count({ where: { organizationId: ORG } })).toBe(2);

    const parity2 = await buildIdentityParityReport(prisma, { organizationId: ORG });
    expect(parity2.parity).toBe('OK');
    expect(parity2.scanned).toBe(parity1.scanned);
    expect(parity2.withCanonicalIdentity).toBe(parity1.withCanonicalIdentity);
    expect(parity2.coverageRate).toBe('1.0000');
  });

  it('可映射的历史行被回填；与已有身份冲突的历史行被拒绝（不覆盖、不猜测）', async () => {
    await detect();
    const mappedRow = await prisma.ruleEvaluation.findFirstOrThrow({
      where: { organizationId: ORG, canonicalFactId: { not: null } },
    });

    // 新的历史行：新增一张未跑过检测的发票（有 ACTIVE 事实），再补一条旧格式评估
    await importCsv(
      [
        'Invoice No,Reference Type,Tracking Number,Invoice Date,Net Charge,Currency',
        'INV-3001,INVOICE,1ZDEMO003,2026-09-01,200.0000,USD',
      ].join('\n'),
      'invoice-extra.csv',
    );
    await importCsv(
      [
        'Tracking Number,Reference Type,Lane,Service,Weight Kg,Amount,Currency',
        '1ZDEMO003,TRACKING,CN-SHA>US-LAX,Ground,12.5000,0.0000,USD',
      ].join('\n'),
      'tracking-extra.csv',
    );
    const extraInvoice = await prisma.sourceTransaction.findFirstOrThrow({
      where: { organizationId: ORG, externalId: 'INV-3001' },
    });
    const backfillable = await prisma.ruleEvaluation.create({
      data: {
        organizationId: ORG,
        ruleVersionId: mappedRow.ruleVersionId,
        sourceTransactionId: extraInvoice.id,
        result: 'OPPORTUNITY',
        computed: { intermediate: { recoverableAmount: '65.0000' } },
        dedupeKey: 'legacy-key-backfillable',
      },
    });

    // 冲突的历史行：同一事实 + 同一规则版本已有新身份行（模拟旧格式重复评估）
    const conflicting = await prisma.ruleEvaluation.create({
      data: {
        organizationId: ORG,
        ruleVersionId: mappedRow.ruleVersionId,
        sourceTransactionId: mappedRow.sourceTransactionId,
        result: 'OPPORTUNITY',
        computed: {},
        dedupeKey: 'legacy-key-conflicting',
      },
    });

    const plan = await planIdentityBackfill(prisma, { organizationId: ORG });
    expect(plan.updates.map((update) => update.ruleEvaluationId)).toEqual([backfillable.id]);
    expect(plan.unmapped.DUPLICATE_TARGET).toBe(1);
    expect(plan.canSwitch).toBe(false);

    const applied = await applyIdentityBackfill(prisma, plan, { dryRun: false });
    expect(applied.updated).toBe(1);

    const backfilled = await prisma.ruleEvaluation.findUniqueOrThrow({ where: { id: backfillable.id } });
    expect(backfilled.canonicalFactId).not.toBeNull();
    expect(backfilled.dedupeKey).toBe('legacy-key-backfillable');
    const untouched = await prisma.ruleEvaluation.findUniqueOrThrow({ where: { id: conflicting.id } });
    expect(untouched.canonicalFactId).toBeNull();

    const parity = await buildIdentityParityReport(prisma, { organizationId: ORG });
    expect(parity.parity).toBe('OK');
    expect(parity.scanned).toBe(4);
    expect(parity.withCanonicalIdentity).toBe(3);
    expect(parity.withoutCanonicalIdentity).toBe(1);
    expect(parity.coverageRate).toBe('0.7500');
    expect(parity.withoutIdentitySamples).toEqual([conflicting.id]);

    const finalPlan = await planIdentityBackfill(prisma, { organizationId: ORG });
    expect(finalPlan.unmapped.DUPLICATE_TARGET).toBe(1);
    expect(finalPlan.canSwitch).toBe(false);
  });

  it('事实为 CONFLICT 时新评估没有身份 → 计数告警而非静默回退', async () => {
    await prisma.canonicalFact.update({
      where: { organizationId_factKey: { organizationId: ORG, factKey: 'INVOICE:INV-1002' } },
      data: { status: 'CONFLICT' },
    });

    const run = await detect();
    expect(run.evaluationsCreated).toBe(2);
    expect(run.evaluationsWithoutCanonicalIdentity).toBe(1);

    const parity = await buildIdentityParityReport(prisma, { organizationId: ORG });
    expect(parity.withCanonicalIdentity).toBe(1);
    expect(parity.withoutCanonicalIdentity).toBe(1);
    expect(parity.coverageRate).toBe('0.5000');
  });

  it('duplicate-resolution-report 说明重复来源与处置建议（只读，不改数据）', async () => {
    await detect();
    const mappedRow = await prisma.ruleEvaluation.findFirstOrThrow({
      where: { organizationId: ORG, canonicalFactId: { not: null } },
    });
    const conflicting = await prisma.ruleEvaluation.create({
      data: {
        organizationId: ORG,
        ruleVersionId: mappedRow.ruleVersionId,
        sourceTransactionId: mappedRow.sourceTransactionId,
        result: 'OPPORTUNITY',
        computed: {},
        dedupeKey: 'legacy-key-duplicate-report',
      },
    });

    const report = await buildDuplicateResolutionReport(prisma, {
      organizationId: ORG,
      generatedAt: new Date('2026-09-28T13:10:00Z'),
    });

    expect(report.resolution).toBe('NEEDS_REVIEW');
    expect(report.totals.DUPLICATE_TARGET).toBe(1);
    expect(report.entries).toHaveLength(1);
    const entry = report.entries[0];
    expect(entry.ruleEvaluationId).toBe(conflicting.id);
    expect(entry.reason).toBe('DUPLICATE_TARGET');
    expect(entry.targetCanonicalFactId).toBe(mappedRow.canonicalFactId);
    expect(entry.existingRuleEvaluationIds).toEqual([mappedRow.id]);
    expect(entry.equivalent).toBe(true);
    expect(entry.recommendation).toBe('KEEP_EXISTING');
    expect(report.unresolved).toBe(0);

    // 报告只读：未映射行仍然保持 NULL
    const stillNull = await prisma.ruleEvaluation.findUniqueOrThrow({ where: { id: conflicting.id } });
    expect(stillNull.canonicalFactId).toBeNull();
    expect(stillNull.canonicalDedupeKey).toBeNull();
  });

  it('canonical 模式正常路径：以 canonicalDedupeKey 判幂等，重复执行零增量', async () => {
    const canonicalRepo = createPrismaDetectionRepository(prisma, { identityMode: 'canonical' });
    const detectCanonical = () =>
      runFreightRateDetection({ organizationId: ORG, scope: SCOPE, repository: canonicalRepo });

    const run1 = await detectCanonical();
    expect(run1.evaluationsCreated).toBe(2);
    expect(run1.evaluationsWithoutCanonicalIdentity).toBe(0);

    const rows = await prisma.ruleEvaluation.findMany({ where: { organizationId: ORG } });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.canonicalDedupeKey !== null)).toBe(true);

    const run2 = await detectCanonical();
    expect(run2.evaluationsCreated).toBe(0);
    expect(run2.skippedExisting).toBe(2);
    expect(await prisma.ruleEvaluation.count({ where: { organizationId: ORG } })).toBe(2);
  });

  it('canonical 模式缺身份：fail closed（CANONICAL_IDENTITY_REQUIRED），不退化到旧键', async () => {
    await prisma.canonicalFact.update({
      where: { organizationId_factKey: { organizationId: ORG, factKey: 'INVOICE:INV-1002' } },
      data: { status: 'CONFLICT' },
    });
    const canonicalRepo = createPrismaDetectionRepository(prisma, { identityMode: 'canonical' });

    await expect(
      runFreightRateDetection({ organizationId: ORG, scope: SCOPE, repository: canonicalRepo }),
    ).rejects.toThrow(/CANONICAL_IDENTITY_REQUIRED/);

    // 可映射的发票已按新身份写入；缺身份的那张绝不写入
    const rows = await prisma.ruleEvaluation.findMany({ where: { organizationId: ORG } });
    expect(rows).toHaveLength(1);
    expect(rows[0].canonicalDedupeKey).not.toBeNull();
    const conflictInvoice = await prisma.sourceTransaction.findFirstOrThrow({
      where: { organizationId: ORG, externalId: 'INV-1002' },
    });
    expect(rows.some((row) => row.sourceTransactionId === conflictInvoice.id)).toBe(false);
  });
});
