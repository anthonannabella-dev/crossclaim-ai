/**
 * C-0006-A — shadow detection parity against real PostgreSQL.
 * ---------------------------------------------------------------
 * End-to-end proof for the migration audit report:
 *   1. rows imported through the dual-write path produce ACTIVE canonical facts
 *   2. legacy detection input and canonical-fact detection input agree
 *      (golden freight numbers: INV-1001 expected 135.0000 / recoverable 17.7500)
 *   3. once a fact is CONFLICT, the shadow path excludes that invoice and the
 *      report names it as a mismatch — which is exactly what C-0006-B must not
 *      silently do.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  buildDetectionParityReport,
  loadActiveFactTransactionIds,
  renderMigrationAuditReport,
  type DetectionInputs,
} from '../services/canonical';
import {
  createPrismaFileAssetPort,
  createPrismaSourceConnectionPort,
  uploadFileAndImport,
} from '../services/acquisition';
import { createAuditWriter, createPrismaAuditSink } from '../services/audit';
import { createPrismaImportRepository } from '../services/ingest';
import { createPrismaDetectionRepository } from '../services/rules';
import { LocalFileSystemStorage } from '../services/storage';

const prisma = new PrismaClient();
const ORG = 'a0000000-0000-4000-8000-000000000001';
const SALT = 'gate4-parity-audit-salt-0123456789';
const SCOPE = { domain: 'LOGISTICS', channel: 'OTHER' } as const;
const fixtures = path.join(__dirname, '..', '..', 'fixtures', 'logistics');

const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-parity-'));
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
  'Tracking Number,Reference Type,Lane,Service,Weight Kg',
  '1ZDEMO001,TRACKING,CN-SHA>US-LAX,Ground,12.5000',
  '1ZDEMO002,TRACKING,CN-SHA>US-LAX,Ground,12.5000',
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
      scope: string;
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
    'TRUNCATE TABLE "AuditLog", "CanonicalFactSource", "CanonicalFact", "RuleEvaluation", "RecoveryOpportunity", "RuleVersion", "RuleSet", "SourceTransaction", "ImportBatch", "FileAsset", "SourceConnection", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: '对拍租户', slug: 'parity-org' } });
  const connection = await prisma.sourceConnection.create({
    data: {
      organizationId: ORG,
      domain: 'LOGISTICS',
      channel: 'OTHER',
      kind: 'FILE_UPLOAD',
      status: 'ACTIVE',
      label: 'parity upload',
    },
  });
  connectionId = connection.id;

  await seedRules();
  await importCsv(INVOICE_CSV, 'invoice.csv');
  await importCsv(TRACKING_CSV, 'tracking.csv');
});

async function buildReport() {
  const invoices = await detection.listInvoices(ORG, SCOPE);
  const tracking = await detection.listTracking(ORG, SCOPE);
  const candidates = await detection.listFreightRateRuleCandidates(ORG, SCOPE);
  const allowed = await loadActiveFactTransactionIds(prisma, { organizationId: ORG, ...SCOPE });
  const scopeTransactionCount = await prisma.sourceTransaction.count({
    where: { organizationId: ORG, ...SCOPE },
  });

  const legacyInputs: DetectionInputs = { invoices, tracking, candidates };
  const shadowInputs: DetectionInputs = {
    invoices: invoices.filter((row) => allowed.has(row.sourceTransactionId)),
    tracking: tracking.filter((row) => allowed.has(row.sourceTransactionId)),
    candidates,
  };

  return buildDetectionParityReport({
    organizationId: ORG,
    scope: SCOPE,
    legacyInputs,
    shadowInputs,
    counts: {
      activeFactTransactions: allowed.size,
      excludedTransactions: Math.max(0, scopeTransactionCount - allowed.size),
    },
    generatedAt: new Date('2026-09-28T12:00:00Z'),
  });
}

describe('C-0006-A — shadow detection parity（真实 PostgreSQL）', () => {
  it('双写产生 ACTIVE 事实后，旧路径与事实路径的检测结果完全一致（黄金数字）', async () => {
    const facts = await prisma.canonicalFact.findMany({ where: { organizationId: ORG } });
    expect(facts).toHaveLength(4);
    expect(facts.every((fact) => fact.status === 'ACTIVE')).toBe(true);

    const report = await buildReport();

    expect(report.parity).toBe('OK');
    expect(report.mismatches).toHaveLength(0);
    expect(report.counts.legacyInvoices).toBe(2);
    expect(report.counts.shadowInvoices).toBe(2);
    expect(report.counts.activeFactTransactions).toBe(4);
    expect(report.counts.excludedTransactions).toBe(0);
    expect(report.legacy.opportunitiesCreated).toBe(2);
    expect(report.shadow.opportunitiesCreated).toBe(2);

    const invoice = report.rows.find((row) => row.invoiceExternalId === 'INV-1001');
    expect(invoice?.legacyExpected).toBe('135.0000');
    expect(invoice?.legacyActual).toBe('152.7500');
    expect(invoice?.legacyRecoverable).toBe('17.7500');
    expect(invoice?.shadowRecoverable).toBe('17.7500');
    expect(invoice?.equal).toBe(true);

    expect(await prisma.ruleEvaluation.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it('某个事实变成 CONFLICT 后，shadow 路径排除该发票并报出 MISMATCH', async () => {
    await prisma.canonicalFact.update({
      where: { organizationId_factKey: { organizationId: ORG, factKey: 'INVOICE:INV-1002' } },
      data: { status: 'CONFLICT' },
    });

    const report = await buildReport();

    expect(report.parity).toBe('MISMATCH');
    expect(report.counts.shadowInvoices).toBe(1);
    expect(report.counts.excludedTransactions).toBe(1);
    expect(report.mismatches.some((line) => line.includes('INV-1002'))).toBe(true);

    const excluded = report.rows.find((row) => row.invoiceExternalId === 'INV-1002');
    expect(excluded?.shadowResult).toBeNull();
    expect(excluded?.note).toContain('EXCLUDED_IN_SHADOW');

    const markdown = renderMigrationAuditReport(report);
    expect(markdown).toContain('parity: **MISMATCH**');
    expect(markdown).toContain('INV-1002');
  });
});
