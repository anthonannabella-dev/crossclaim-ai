/**
 * C-0007 Phase 2 — Upload Runtime against real PostgreSQL.
 * ------------------------------------------------------------------
 * Positive: CSV → scan PASSED → Storage → FileAsset → ImportBatch →
 *           SourceTransaction → CanonicalFact (dual write).
 * Negative (all fail closed): MIME spoof; duplicate upload must not create a
 * second business asset.
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
  uploadWithScan,
} from '../services/acquisition';
import { createAuditWriter, createPrismaAuditSink } from '../services/audit';
import { createPrismaImportRepository } from '../services/ingest';
import { LocalFileSystemStorage } from '../services/storage';

const prisma = new PrismaClient();
const ORG = 'a1000000-0000-4000-8000-000000000001';
const SALT = 'gate5-upload-runtime-salt-0123456789';

const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-upload-'));
const storage = new LocalFileSystemStorage({
  rootDir: storageRoot,
  secret: SALT,
  publicBaseUrl: 'http://localhost:3000',
});

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const imports = createPrismaImportRepository(prisma, { audit });
const connections = createPrismaSourceConnectionPort(prisma);
const fileAssets = createPrismaFileAssetPort(prisma);
const fileAssetLookup = createPrismaFileAssetLookup(prisma);

let connectionId = '';

const CSV = Buffer.from(
  [
    'Invoice No,Reference Type,Tracking Number,Invoice Date,Net Charge,Currency',
    'INV-4001,INVOICE,1ZDEMO401,2026-09-01,150.0000,USD',
  ].join('\n'),
  'utf8',
);

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
  await prisma.organization.create({ data: { id: ORG, name: '上传租户', slug: 'upload-org' } });
  const connection = await prisma.sourceConnection.create({
    data: {
      organizationId: ORG,
      domain: 'LOGISTICS',
      channel: 'OTHER',
      kind: 'FILE_UPLOAD',
      status: 'ACTIVE',
      label: 'upload runtime',
    },
  });
  connectionId = connection.id;
});

const deps = () => ({ connections, fileAssets, fileAssetLookup, storage, imports, audit });

describe('C-0007 Phase 2 — upload runtime（真实 PostgreSQL）', () => {
  it('CSV 上传：扫描 PASSED → FileAsset → ImportBatch → SourceTransaction → CanonicalFact', async () => {
    const result = await uploadWithScan(
      {
        organizationId: ORG,
        connectionId,
        domain: 'LOGISTICS',
        channel: 'OTHER',
        kind: 'CSV',
        originalName: 'invoices.csv',
        declaredMime: 'text/csv',
        body: CSV,
      },
      deps(),
    );

    expect(result.status).toBe('IMPORTED');
    expect(result.scan.status).toBe('PASSED');
    expect(result.scan.detectedMime).toBe('text/csv');
    expect(result.import?.status).toBe('IMPORTED');

    expect(await prisma.fileAsset.count({ where: { organizationId: ORG } })).toBe(1);
    expect(await prisma.sourceTransaction.count({ where: { organizationId: ORG } })).toBe(1);
    expect(await prisma.canonicalFact.count({ where: { organizationId: ORG } })).toBe(1);

    const actions = (
      await prisma.auditLog.findMany({ where: { organizationId: ORG }, orderBy: { createdAt: 'asc' } })
    ).map((entry) => entry.action);
    expect(actions).toContain('file.scan_passed');
    expect(actions).toContain('file.uploaded');
    expect(actions).toContain('import.completed');

    const scanAudit = await prisma.auditLog.findFirstOrThrow({
      where: { organizationId: ORG, action: 'file.scan_passed' },
    });
    const changes = scanAudit.changes as Record<string, unknown>;
    expect(changes.scanStatus).toBe('PASSED');
    expect(changes.detectedMime).toBe('text/csv');
    expect(String(changes.sha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(changes.sizeBytes).toBe(CSV.length);
  });

  it('重复上传（同租户 + 同 sha256）不产生第二份业务资产', async () => {
    const first = await uploadWithScan(
      {
        organizationId: ORG,
        connectionId,
        domain: 'LOGISTICS',
        channel: 'OTHER',
        kind: 'CSV',
        originalName: 'invoices.csv',
        declaredMime: 'text/csv',
        body: CSV,
      },
      deps(),
    );
    const second = await uploadWithScan(
      {
        organizationId: ORG,
        connectionId,
        domain: 'LOGISTICS',
        channel: 'OTHER',
        kind: 'CSV',
        originalName: 'invoices-copy.csv',
        declaredMime: 'text/csv',
        body: Buffer.from(CSV),
      },
      deps(),
    );

    expect(second.status).toBe('DUPLICATE');
    expect(second.fileAssetId).toBe(first.fileAssetId);
    expect(second.import).toBeNull();
    expect(await prisma.fileAsset.count({ where: { organizationId: ORG } })).toBe(1);
    expect(await prisma.sourceTransaction.count({ where: { organizationId: ORG } })).toBe(1);
    expect(
      await prisma.auditLog.count({ where: { organizationId: ORG, action: 'file.upload_duplicate' } }),
    ).toBe(1);
  });

  it('MIME 伪造（text/csv + PE 头）被拒绝：不落 FileAsset、不写存储、留拒绝审计', async () => {
    const spoofed = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(128, 0x41)]);

    await expect(
      uploadWithScan(
        {
          organizationId: ORG,
          connectionId,
          domain: 'LOGISTICS',
          channel: 'OTHER',
          kind: 'CSV',
          originalName: 'invoices.csv',
          declaredMime: 'text/csv',
          body: spoofed,
        },
        deps(),
      ),
    ).rejects.toThrow(/上传被拒绝/);

    expect(await prisma.fileAsset.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await prisma.sourceTransaction.count({ where: { organizationId: ORG } })).toBe(0);
    const rejected = await prisma.auditLog.findFirstOrThrow({
      where: { organizationId: ORG, action: 'file.upload_failed' },
    });
    const changes = rejected.changes as Record<string, unknown>;
    expect(changes.scanStatus).toBe('REJECTED');
    expect(changes.scanReason).toBe('EXECUTABLE_DETECTED');
    expect(changes.detectedMime).toBe('application/x-dosexec');
  });
});
