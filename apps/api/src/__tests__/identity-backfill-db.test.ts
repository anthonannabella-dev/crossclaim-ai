/**
 * C-0006-B2 — identity backfill planner against real PostgreSQL.
 * ---------------------------------------------------------------
 * Step 1 boundary: measure only. Proves
 *   - mappable rows (exactly one ACTIVE fact) produce canonicalFactId +
 *     canonicalDedupeKey
 *   - CONFLICT facts and rows without a fact stay unmapped and are classified
 *   - dry-run writes nothing; the old dedupeKey stays the only identity in use
 *   - unmapped = 0 is the gate for any future switch
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  applyIdentityBackfill,
  canonicalDedupeKeyFor,
  planIdentityBackfill,
} from '../services/canonical';
import {
  createPrismaFileAssetPort,
  createPrismaSourceConnectionPort,
  uploadFileAndImport,
} from '../services/acquisition';
import { createAuditWriter, createPrismaAuditSink } from '../services/audit';
import { createPrismaImportRepository } from '../services/ingest';
import { LocalFileSystemStorage } from '../services/storage';

const prisma = new PrismaClient();
const ORG = 'c0000000-0000-4000-8000-000000000001';
const SALT = 'gate4-identity-audit-salt-0123456789';
const fixtures = path.join(__dirname, '..', '..', 'fixtures', 'logistics');

const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-identity-'));
const storage = new LocalFileSystemStorage({
  rootDir: storageRoot,
  secret: SALT,
  publicBaseUrl: 'http://localhost:3000',
});

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const imports = createPrismaImportRepository(prisma, { audit });
const connections = createPrismaSourceConnectionPort(prisma);
const fileAssets = createPrismaFileAssetPort(prisma);

let connectionId = '';
let ruleVersionId = '';

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

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "RuleEvaluationShadow", "CanonicalFactSource", "CanonicalFact", "RuleEvaluation", "RecoveryOpportunity", "RuleVersion", "RuleSet", "SourceTransaction", "ImportBatch", "FileAsset", "SourceConnection", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: '身份租户', slug: 'identity-org' } });
  const connection = await prisma.sourceConnection.create({
    data: {
      organizationId: ORG,
      domain: 'LOGISTICS',
      channel: 'OTHER',
      kind: 'FILE_UPLOAD',
      status: 'ACTIVE',
      label: 'identity upload',
    },
  });
  connectionId = connection.id;

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
      const createdVersion = await prisma.ruleVersion.create({
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
      ruleVersionId = createdVersion.id;
    }
  }

  for (const [body, name] of [
    [INVOICE_CSV, 'invoice.csv'],
    [TRACKING_CSV, 'tracking.csv'],
  ] as const) {
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
});

async function transactionIdFor(invoiceNo: string): Promise<string> {
  const row = await prisma.sourceTransaction.findFirstOrThrow({
    where: { organizationId: ORG, externalId: invoiceNo },
  });
  return row.id;
}

async function createLegacyEvaluation(invoiceNo: string, dedupeKey: string): Promise<string> {
  const sourceTransactionId = await transactionIdFor(invoiceNo);
  const created = await prisma.ruleEvaluation.create({
    data: {
      organizationId: ORG,
      ruleVersionId,
      sourceTransactionId,
      result: 'OPPORTUNITY',
      computed: { intermediate: { recoverableAmount: '17.7500' } },
      dedupeKey,
    },
  });
  return created.id;
}

describe('C-0006-B2 — identity backfill planner（真实 PostgreSQL）', () => {
  it('可映射行产出新身份；dry-run 不写库；unmapped 分类正确', async () => {
    const mappedId = await createLegacyEvaluation('INV-1001', 'legacy-key-1');
    const conflictId = await createLegacyEvaluation('INV-1002', 'legacy-key-2');

    // 一张没有任何事实的原始行（历史/异常输入）
    const orphan = await prisma.sourceTransaction.create({
      data: {
        organizationId: ORG,
        connectionId,
        domain: 'LOGISTICS',
        channel: 'OTHER',
        externalId: 'INV-ORPHAN',
        referenceType: 'INVOICE',
        occurredAt: new Date('2026-09-02T00:00:00Z'),
        amount: new Prisma.Decimal('10.0000'),
        currency: 'USD',
        dedupeKey: 'orphan-key-1',
        raw: { 'Invoice No': 'INV-ORPHAN' },
      },
    });
    const orphanEvaluation = await prisma.ruleEvaluation.create({
      data: {
        organizationId: ORG,
        ruleVersionId,
        sourceTransactionId: orphan.id,
        result: 'PASS',
        computed: {},
        dedupeKey: 'legacy-key-3',
      },
    });

    // INV-1002 的事实置为 CONFLICT
    await prisma.canonicalFact.updateMany({
      where: { organizationId: ORG, accountId: null, factKey: 'INVOICE:INV-1002' },
      data: { status: 'CONFLICT' },
    });

    const plan = await planIdentityBackfill(prisma, { organizationId: ORG });

    expect(plan.scanned).toBe(3);
    expect(plan.alreadyMapped).toBe(0);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].ruleEvaluationId).toBe(mappedId);
    const mappedFact = await prisma.canonicalFact.findFirstOrThrow({
      where: { organizationId: ORG, factKey: 'INVOICE:INV-1001' },
    });
    expect(plan.updates[0].canonicalFactId).toBe(mappedFact.id);
    expect(plan.updates[0].canonicalDedupeKey).toBe(
      canonicalDedupeKeyFor({
        organizationId: ORG,
        ruleVersionId,
        canonicalFactId: mappedFact.id,
      }),
    );
    expect(plan.unmapped.CONFLICT_FACT).toBe(1);
    expect(plan.unmapped.NO_ACTIVE_FACT).toBe(1);
    expect(plan.canSwitch).toBe(false);

    const dryRun = await applyIdentityBackfill(prisma, plan, { dryRun: true });
    expect(dryRun.updated).toBe(0);
    const untouchedMapped = await prisma.ruleEvaluation.findUniqueOrThrow({ where: { id: mappedId } });
    const untouchedConflict = await prisma.ruleEvaluation.findUniqueOrThrow({ where: { id: conflictId } });
    const untouchedOrphan = await prisma.ruleEvaluation.findUniqueOrThrow({ where: { id: orphanEvaluation.id } });
    expect(untouchedMapped.canonicalDedupeKey).toBeNull();
    expect(untouchedConflict.canonicalFactId).toBeNull();
    expect(untouchedOrphan.canonicalFactId).toBeNull();
  });

  it('全部可映射时 canSwitch = true，apply 后再跑一次即 alreadyMapped', async () => {
    const first = await createLegacyEvaluation('INV-1001', 'legacy-key-11');
    const second = await createLegacyEvaluation('INV-1002', 'legacy-key-12');

    const before = await planIdentityBackfill(prisma, { organizationId: ORG });
    expect(before.updates).toHaveLength(2);
    expect(Object.values(before.unmapped).reduce((sum, value) => sum + value, 0)).toBe(0);
    expect(before.canSwitch).toBe(true);

    const applied = await applyIdentityBackfill(prisma, before, { dryRun: false });
    expect(applied.updated).toBe(2);

    const rows = await prisma.ruleEvaluation.findMany({ where: { organizationId: ORG } });
    for (const row of rows) {
      expect(row.canonicalFactId).not.toBeNull();
      expect(row.canonicalDedupeKey).not.toBeNull();
      // 旧身份键保持不变（Step 1/2 期间双键同存）
      expect(row.dedupeKey).not.toBeNull();
    }
    expect(rows.find((row) => row.id === first)?.canonicalDedupeKey).toMatch(/^[0-9a-f]{64}$/);
    expect(rows.find((row) => row.id === second)?.canonicalFactId).not.toBeNull();

    const after = await planIdentityBackfill(prisma, { organizationId: ORG });
    expect(after.alreadyMapped).toBe(2);
    expect(after.updates).toHaveLength(0);

    // 新旧身份同存：旧 dedupeKey 唯一约束未动，新 canonicalDedupeKey 唯一约束生效
    const alreadyUsed = rows.find((row) => row.id === first)!;
    await expect(
      prisma.ruleEvaluation.create({
        data: {
          organizationId: ORG,
          ruleVersionId,
          sourceTransactionId: alreadyUsed.sourceTransactionId,
          canonicalFactId: alreadyUsed.canonicalFactId,
          canonicalDedupeKey: alreadyUsed.canonicalDedupeKey,
          result: 'PASS',
          computed: {},
          dedupeKey: 'legacy-key-duplicate-identity',
        },
      }),
    ).rejects.toThrow();
  });
});
