/**
 * C-0006-B1 — canonical shadow run against real PostgreSQL.
 * ---------------------------------------------------------------
 * Proves the approved B1 contract:
 *   - the canonical path evaluates ACTIVE facts and writes ONLY
 *     RuleEvaluationShadow (runId + engineVersion + canonicalFactId)
 *   - nothing enters RuleEvaluation / RecoveryOpportunity / 资金链
 *   - CONFLICT facts are excluded from the input and audited per fact
 *   - one run-level audit event summarises the run
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runCanonicalShadow } from '../services/canonical';
import {
  createPrismaFileAssetPort,
  createPrismaSourceConnectionPort,
  uploadFileAndImport,
} from '../services/acquisition';
import { createAuditWriter, createPrismaAuditSink } from '../services/audit';
import { createPrismaImportRepository } from '../services/ingest';
import { LocalFileSystemStorage } from '../services/storage';

const prisma = new PrismaClient();
const ORG = 'b0000000-0000-4000-8000-000000000001';
const SALT = 'gate4-shadow-audit-salt-0123456789';
const SCOPE = { domain: 'LOGISTICS', channel: 'OTHER' } as const;
const fixtures = path.join(__dirname, '..', '..', 'fixtures', 'logistics');

const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-shadow-'));
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
    'TRUNCATE TABLE "AuditLog", "RuleEvaluationShadow", "CanonicalFactSource", "CanonicalFact", "RuleEvaluation", "RecoveryOpportunity", "Case", "Claim", "Settlement", "RuleVersion", "RuleSet", "SourceTransaction", "ImportBatch", "FileAsset", "SourceConnection", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: '影子租户', slug: 'shadow-org' } });
  const connection = await prisma.sourceConnection.create({
    data: {
      organizationId: ORG,
      domain: 'LOGISTICS',
      channel: 'OTHER',
      kind: 'FILE_UPLOAD',
      status: 'ACTIVE',
      label: 'shadow upload',
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

describe('C-0006-B1 — canonical shadow run（真实 PostgreSQL）', () => {
  it('只用 ACTIVE 事实评估并只写影子表，不产生 Opportunity', async () => {
    const summary = await runCanonicalShadow({
      prisma,
      organizationId: ORG,
      scope: SCOPE,
      audit,
      runId: 'shadow-run-test-1',
      now: () => new Date('2026-09-28T12:40:00Z'),
    });

    expect(summary.runId).toBe('shadow-run-test-1');
    expect(summary.activeInvoices).toBe(2);
    expect(summary.activeTracking).toBe(2);
    expect(summary.conflictFactsExcluded).toBe(0);
    expect(summary.evaluationsWritten).toBe(2);
    expect(summary.opportunitiesFound).toBe(1);
    expect(summary.moneyTrace).toBe('17.7500');
    expect(summary.factCoverage.sourceTransactions).toBe(4);
    expect(summary.factCoverage.activeFactTransactions).toBe(4);

    const shadows = await prisma.ruleEvaluationShadow.findMany({
      where: { organizationId: ORG },
      orderBy: { evaluatedAt: 'asc' },
    });
    expect(shadows).toHaveLength(2);
    for (const shadow of shadows) {
      expect(shadow.runId).toBe('shadow-run-test-1');
      expect(shadow.engineVersion).toBe('FREIGHT_RATE_V1@1');
      expect(shadow.representativeTransactionId).not.toBeNull();
    }
    const opportunity = shadows.find((shadow) => shadow.result === 'OPPORTUNITY');
    expect(opportunity).toBeDefined();
    const fact = await prisma.canonicalFact.findFirstOrThrow({
      where: { organizationId: ORG, factKey: 'INVOICE:INV-1001' },
    });
    expect(opportunity?.canonicalFactId).toBe(fact.id);
    const computed = opportunity?.computed as unknown as { intermediate: { recoverableAmount: string } };
    expect(computed.intermediate.recoverableAmount).toBe('17.7500');

    // 影子运行不得污染正式链路
    expect(await prisma.ruleEvaluation.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await prisma.recoveryOpportunity.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await prisma.case.count({ where: { organizationId: ORG } })).toBe(0);

    const runAudit = await prisma.auditLog.findFirstOrThrow({
      where: { organizationId: ORG, action: 'rule_evaluation.shadow_completed' },
    });
    expect(runAudit.actorRef).toBe('canonical-shadow-runner');
    expect((runAudit.changes as Record<string, unknown>).evaluatedCount).toBe(2);
    expect((runAudit.changes as Record<string, unknown>).excludedConflictCount).toBe(0);
  });

  it('CONFLICT 事实被排除并逐条审计', async () => {
    await prisma.canonicalFact.update({
      where: { organizationId_factKey: { organizationId: ORG, factKey: 'INVOICE:INV-1002' } },
      data: { status: 'CONFLICT' },
    });

    const summary = await runCanonicalShadow({
      prisma,
      organizationId: ORG,
      scope: SCOPE,
      audit,
      runId: 'shadow-run-test-2',
      now: () => new Date('2026-09-28T12:41:00Z'),
    });

    expect(summary.activeInvoices).toBe(1);
    expect(summary.conflictFactsExcluded).toBe(1);
    expect(summary.excludedFactKeys).toEqual(['INVOICE:INV-1002']);
    expect(summary.evaluationsWritten).toBe(1);
    expect(summary.moneyTrace).toBe('17.7500');
    expect(summary.factCoverage.sourceTransactions).toBe(4);
    expect(summary.factCoverage.activeFactTransactions).toBe(3);
    expect(summary.factCoverage.conflictFactTransactions).toBe(1);

    const conflictAudit = await prisma.auditLog.findFirstOrThrow({
      where: { organizationId: ORG, action: 'canonical_fact.conflict_detected' },
    });
    expect(conflictAudit.entityId).toBe('INVOICE:INV-1002');
    expect((conflictAudit.changes as Record<string, unknown>).runId).toBe('shadow-run-test-2');

    const shadows = await prisma.ruleEvaluationShadow.findMany({ where: { organizationId: ORG } });
    expect(shadows).toHaveLength(1);
    expect(shadows[0].runId).toBe('shadow-run-test-2');
  });
});
