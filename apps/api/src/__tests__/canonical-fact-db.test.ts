/**
 * C-0006-A — canonical fact layer against real PostgreSQL.
 * ---------------------------------------------------------------
 * Proves that
 *   - SourceTransaction and CanonicalFact / CanonicalFactSource are written
 *     together (same import call), with source provenance preserved
 *   - the same fact arriving from a second source with a different amount is
 *     persisted as CONFLICT and audited, never silently merged
 *   - re-importing the same file is idempotent for raw rows, facts and links
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createPrismaFileAssetPort,
  createPrismaSourceConnectionPort,
  uploadFileAndImport,
} from '../services/acquisition';
import { createAuditWriter, createPrismaAuditSink } from '../services/audit';
import { createPrismaImportRepository } from '../services/ingest';
import { LocalFileSystemStorage } from '../services/storage';

const prisma = new PrismaClient();
const ORG = '88888888-8888-4888-8888-888888888888';
const SALT = 'gate4-canonical-fact-audit-salt-0123456';

const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-canonical-'));
const storage = new LocalFileSystemStorage({
  rootDir: storageRoot,
  secret: SALT,
  publicBaseUrl: 'http://localhost:3000',
});

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const imports = createPrismaImportRepository(prisma, { audit });
const connections = createPrismaSourceConnectionPort(prisma);
const fileAssets = createPrismaFileAssetPort(prisma);

let connectionA = '';
let connectionB = '';

const HEADER = 'Invoice No,Reference Type,Invoice Date,Net Charge,Currency';

function csv(invoiceNo: string, amount: string) {
  return Buffer.from([HEADER, `${invoiceNo},INVOICE,2026-09-08,${amount},USD`].join('\n'), 'utf8');
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "CanonicalFactSource", "CanonicalFact", "SourceTransaction", "ImportBatch", "FileAsset", "SourceConnection", "PlatformAccount", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: '事实层租户', slug: 'canonical-org' } });
  // TRACK B BATCH 1：ingest 入口要求连接已绑定 PlatformAccount（服务端派生 account 归因）。
  const account = await prisma.platformAccount.create({
    data: {
      organizationId: ORG,
      platform: 'UPS',
      externalAccountId: 'fixture-' + ORG,
      displayName: 'fixture account',
    },
  });
  const a = await prisma.sourceConnection.create({
    data: {
      organizationId: ORG,
      domain: 'LOGISTICS',
      channel: 'UPS',
      kind: 'FILE_UPLOAD',
      status: 'ACTIVE',
      platformAccountId: account.id,
      label: 'upload A',
    },
  });
  connectionA = a.id;
  const b = await prisma.sourceConnection.create({
    data: {
      organizationId: ORG,
      domain: 'LOGISTICS',
      channel: 'UPS',
      kind: 'FILE_UPLOAD',
      status: 'ACTIVE',
      platformAccountId: account.id,
      label: 'upload B',
    },
  });
  connectionB = b.id;
});

async function upload(connectionId: string, invoiceNo: string, amount: string) {
  return uploadFileAndImport(
    {
      organizationId: ORG,
      connectionId,
      domain: 'LOGISTICS',
      channel: 'UPS',
      kind: 'CSV',
      originalName: 'fact.csv',
      body: csv(invoiceNo, amount),
    },
    { connections, fileAssets, storage, imports, audit },
  );
}

describe('C-0006-A — canonical fact layer（真实 PostgreSQL）', () => {
  it('原始行与业务事实在同一次导入中一起落库，并保留来源', async () => {
    const result = await upload(connectionA, 'INV-9101', '100.0000');
    expect(result.import.status).toBe('IMPORTED');

    const transaction = await prisma.sourceTransaction.findFirstOrThrow({
      where: { organizationId: ORG },
    });
    const fact = await prisma.canonicalFact.findFirstOrThrow({ where: { organizationId: ORG } });

    expect(fact.factKey).toBe('INVOICE:INV-9101');
    expect(fact.status).toBe('ACTIVE');
    expect(fact.sourceCount).toBe(1);
    expect(fact.confirmedAcrossModes).toBe(false);
    expect(fact.amount?.toFixed(4)).toBe('100.0000');
    expect(fact.currency).toBe('USD');

    const links = await prisma.canonicalFactSource.findMany({ where: { organizationId: ORG } });
    expect(links).toHaveLength(1);
    expect(links[0].canonicalFactId).toBe(fact.id);
    expect(links[0].sourceTransactionId).toBe(transaction.id);
    expect(links[0].connectionKind).toBe('FILE_UPLOAD');
    expect(links[0].observedAt).toBeInstanceOf(Date);

    // RuleEvaluation is not touched by the fact layer itself
    expect(await prisma.ruleEvaluation.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it('同一事实来自第二个来源且金额不一致 → CONFLICT + 审计，且两条原始行都保留', async () => {
    await upload(connectionA, 'INV-9102', '100.0000');
    await upload(connectionB, 'INV-9102', '150.0000');

    expect(await prisma.sourceTransaction.count({ where: { organizationId: ORG } })).toBe(2);

    const fact = await prisma.canonicalFact.findFirstOrThrow({ where: { organizationId: ORG } });
    expect(fact.factKey).toBe('INVOICE:INV-9102');
    expect(fact.status).toBe('CONFLICT');
    expect(fact.sourceCount).toBe(2);
    expect(await prisma.canonicalFactSource.count({ where: { organizationId: ORG } })).toBe(2);

    const conflictAudit = await prisma.auditLog.findFirstOrThrow({
      where: { organizationId: ORG, action: 'canonical_fact.conflict' },
    });
    expect(conflictAudit.actorType).toBe('SYSTEM');
    expect(conflictAudit.actorRef).toBe('canonical-fact-writer');
    expect((conflictAudit.changes as Record<string, unknown>).reason).toBe('AMOUNT_MISMATCH');
  });

  it('同一事实来自两个来源且金额一致 → ACTIVE 且 sourceCount = 2', async () => {
    await upload(connectionA, 'INV-9103', '100.0000');
    await upload(connectionB, 'INV-9103', '100.0000');

    const fact = await prisma.canonicalFact.findFirstOrThrow({ where: { organizationId: ORG } });
    expect(fact.status).toBe('ACTIVE');
    expect(fact.sourceCount).toBe(2);
    expect(await prisma.canonicalFactSource.count({ where: { organizationId: ORG } })).toBe(2);
    expect(await prisma.auditLog.count({ where: { organizationId: ORG, action: 'canonical_fact.conflict' } })).toBe(0);
  });

  it('重复导入同一文件：原始行、事实与来源联结都不重复', async () => {
    await upload(connectionA, 'INV-9104', '100.0000');
    await upload(connectionA, 'INV-9104', '100.0000');

    expect(await prisma.sourceTransaction.count({ where: { organizationId: ORG } })).toBe(1);
    expect(await prisma.canonicalFact.count({ where: { organizationId: ORG } })).toBe(1);
    expect(await prisma.canonicalFactSource.count({ where: { organizationId: ORG } })).toBe(1);
    const fact = await prisma.canonicalFact.findFirstOrThrow({ where: { organizationId: ORG } });
    expect(fact.sourceCount).toBe(1);
    expect(fact.status).toBe('ACTIVE');
  });
});
