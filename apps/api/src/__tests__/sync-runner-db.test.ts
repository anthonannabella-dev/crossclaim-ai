/**
 * C-0007 Phase 4 — recovery scenario against real PostgreSQL.
 * ------------------------------------------------------------------
 * Approved requirement: 上传成功 → 导入失败 → 重试 → 成功, and the second
 * attempt must not duplicate business rows (never 2N).
 *
 *   attempt 1: FileAsset = 1, ImportBatch FAILED, SourceTransaction = 0
 *   attempt 2: ImportBatch IMPORTED, SourceTransaction = N, CanonicalFact = N
 *   attempt 3: skipped, counts unchanged
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createPrismaFileAssetLookup,
  createPrismaFileAssetPort,
  createPrismaSourceConnectionPort,
  runScheduledSync,
  uploadWithScan,
} from '../services/acquisition';
import { createAuditWriter, createPrismaAuditSink } from '../services/audit';
import {
  createPrismaImportRepository,
  type ImportBatchDraft,
  type ImportRepository,
  type TransactionInsert,
} from '../services/ingest';
import { LocalFileSystemStorage } from '../services/storage';

const prisma = new PrismaClient();
const ORG = 'a4000000-0000-4000-8000-000000000001';
const SALT = 'gate5-runner-db-salt-0123456789';

const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-runner-'));
const storage = new LocalFileSystemStorage({
  rootDir: storageRoot,
  secret: SALT,
  publicBaseUrl: 'http://localhost:3000',
});

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const goodRepository = createPrismaImportRepository(prisma, { audit });
const connections = createPrismaSourceConnectionPort(prisma);
const fileAssets = createPrismaFileAssetPort(prisma);
const fileAssetLookup = createPrismaFileAssetLookup(prisma);

let connectionId = '';

const CSV = Buffer.from(
  [
    'Invoice No,Reference Type,Tracking Number,Invoice Date,Net Charge,Currency',
    'INV-6001,INVOICE,1ZDEMO601,2026-09-01,150.0000,USD',
    'INV-6002,INVOICE,1ZDEMO602,2026-09-02,180.0000,USD',
  ].join('\n'),
  'utf8',
);

/** Fails the first insert, then behaves exactly like the Prisma repository. */
function flakyRepository(failures: number): ImportRepository {
  let remaining = failures;
  return {
    createBatch: (data: ImportBatchDraft) => goodRepository.createBatch(data),
    updateBatch: (id: string, data: Partial<ImportBatchDraft>) => goodRepository.updateBatch(id, data),
    async insertTransactions(rows: TransactionInsert[]) {
      if (remaining > 0) {
        remaining -= 1;
        throw new Error('transient database failure');
      }
      return goodRepository.insertTransactions(rows);
    },
  };
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
    'TRUNCATE TABLE "AuditLog", "CanonicalFactSource", "CanonicalFact", "SourceTransaction", "ImportBatch", "FileAsset", "SourceConnection", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: '重试租户', slug: 'runner-org' } });
  const connection = await prisma.sourceConnection.create({
    data: {
      organizationId: ORG,
      domain: 'LOGISTICS',
      channel: 'OTHER',
      kind: 'FILE_UPLOAD',
      status: 'ACTIVE',
      label: 'runner upload',
    },
  });
  connectionId = connection.id;
});

describe('C-0007 Phase 4 — recoverability（真实 PostgreSQL）', () => {
  it('上传成功→导入失败→重试→成功，且不会出现 2N', async () => {
    const flaky = flakyRepository(1);

    // attempt 1: FileAsset 已落库，但导入失败
    await expect(
      uploadWithScan(
        {
          organizationId: ORG,
          connectionId,
          domain: 'LOGISTICS',
          channel: 'OTHER',
          kind: 'CSV',
          originalName: 'retry.csv',
          declaredMime: 'text/csv',
          body: CSV,
        },
        { connections, fileAssets, fileAssetLookup, storage, imports: flaky, audit },
      ),
    ).rejects.toThrow(/transient database failure/);

    expect(await prisma.fileAsset.count({ where: { organizationId: ORG } })).toBe(1);
    expect(await prisma.sourceTransaction.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await prisma.canonicalFact.count({ where: { organizationId: ORG } })).toBe(0);
    const failedBatch = await prisma.importBatch.findFirstOrThrow({ where: { organizationId: ORG } });
    expect(failedBatch.status).toBe('FAILED');

    // attempt 2: runner 重试同一个 FileAsset
    const retry = await runScheduledSync(
      { organizationId: ORG, connectionId, domain: 'LOGISTICS', channel: 'OTHER', attempt: 1 },
      { prisma, connections, imports: goodRepository, audit, storage },
    );
    expect(retry.status).toBe('SUCCEEDED');
    expect(retry.import?.rowsOk).toBe(2);

    const transactions = await prisma.sourceTransaction.count({ where: { organizationId: ORG } });
    const facts = await prisma.canonicalFact.count({ where: { organizationId: ORG } });
    expect(transactions).toBe(2);
    expect(facts).toBe(2);

    const batches = await prisma.importBatch.findMany({
      where: { organizationId: ORG },
      orderBy: { startedAt: 'asc' },
    });
    expect(batches.map((batch) => batch.status)).toEqual(['FAILED', 'IMPORTED']);

    // attempt 3: 再次运行必须跳过，且计数不变（不是 2N）
    const skipped = await runScheduledSync(
      { organizationId: ORG, connectionId, domain: 'LOGISTICS', channel: 'OTHER', attempt: 2 },
      { prisma, connections, imports: goodRepository, audit, storage },
    );
    expect(skipped.status).toBe('SKIPPED');
    expect(skipped.detail).toBe('ALREADY_IMPORTED');
    expect(await prisma.sourceTransaction.count({ where: { organizationId: ORG } })).toBe(2);
    expect(await prisma.canonicalFact.count({ where: { organizationId: ORG } })).toBe(2);

    const actions = (
      await prisma.auditLog.findMany({ where: { organizationId: ORG }, orderBy: { createdAt: 'asc' } })
    ).map((entry) => entry.action);
    expect(actions).toContain('import.retry_completed');
    expect(actions).toContain('sync_run.completed');
    expect(actions).toContain('sync_run.failed');
  });
});
