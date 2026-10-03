/**
 * C-0005 / Gate 3 — dual-mode acquisition against real PostgreSQL.
 * ---------------------------------------------------------------
 * Proves on a fresh database that
 *   - FILE_UPLOAD really goes bytes → Storage Adapter → FileAsset → ImportBatch → SourceTransaction
 *   - API mode reuses the same canonical ingest and never writes a FileAsset
 *   - both modes leave audit events through the Gate 1 audit writer
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  runApiAcquisition,
  uploadFileAndImport,
  createPrismaFileAssetPort,
  createPrismaSourceConnectionPort,
} from '../services/acquisition';
import type { AdapterPullPage, ExternalAdapter } from '../services/adapters';
import { createAuditWriter, createPrismaAuditSink } from '../services/audit';
import { createPrismaImportRepository } from '../services/ingest';
import { LocalFileSystemStorage } from '../services/storage';

const prisma = new PrismaClient();
const ORG = '66666666-6666-4666-8666-666666666666';
const SALT = 'gate3-acquisition-audit-salt-0123456789';
const fixtures = path.join(__dirname, '..', '..', 'fixtures', 'logistics');

const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-acq-'));
const storage = new LocalFileSystemStorage({
  rootDir: storageRoot,
  secret: SALT,
  publicBaseUrl: 'http://localhost:3000',
});

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const imports = createPrismaImportRepository(prisma);
const connections = createPrismaSourceConnectionPort(prisma);
const fileAssets = createPrismaFileAssetPort(prisma);

let uploadConnectionId = '';
let apiConnectionId = '';

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "EvidenceArtifact", "CaseEvidence", "SourceTransaction", "ImportBatch", "FileAsset", "SourceConnection", "PlatformAccount", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: '采集租户', slug: 'acquisition-org' } });
  // TRACK B BATCH 1：ingest 入口要求连接已绑定 PlatformAccount（服务端派生 account 归因）。
  const account = await prisma.platformAccount.create({
    data: {
      organizationId: ORG,
      platform: 'UPS',
      externalAccountId: 'fixture-' + ORG,
      displayName: 'fixture account',
    },
  });

  const uploadConnection = await prisma.sourceConnection.create({
    data: {
      organizationId: ORG,
      domain: 'LOGISTICS',
      channel: 'OTHER',
      kind: 'FILE_UPLOAD',
      status: 'ACTIVE',
      platformAccountId: account.id,
      label: 'carrier invoice upload',
    },
  });
  uploadConnectionId = uploadConnection.id;

  const apiConnection = await prisma.sourceConnection.create({
    data: {
      organizationId: ORG,
      domain: 'LOGISTICS',
      channel: 'UPS',
      kind: 'API',
      status: 'ACTIVE',
      platformAccountId: account.id,
      label: 'ups fixture api',
      credentialRef: 'CROSSCLAIM_FIXTURE_UPS_RO',
    },
  });
  apiConnectionId = apiConnection.id;
});

const CSV_BODY = () => fs.readFileSync(path.join(fixtures, 'carrier-invoice.csv'));

describe('C-0005 / Gate 3 — acquisition（真实 PostgreSQL）', () => {
  it('文件上传：FileAsset + ImportBatch + SourceTransaction + 审计，且字节可取回', async () => {
    const body = CSV_BODY();

    const result = await uploadFileAndImport(
      {
        organizationId: ORG,
        connectionId: uploadConnectionId,
        domain: 'LOGISTICS',
        channel: 'OTHER',
        kind: 'CSV',
        originalName: 'carrier-invoice.csv',
        mimeType: 'text/csv',
        body,
      },
      { connections, fileAssets, storage, imports, audit },
    );

    expect(result.import.status).toBe('IMPORTED');
    expect(result.import.rowsOk).toBeGreaterThan(0);

    const fileAsset = await prisma.fileAsset.findFirstOrThrow({ where: { organizationId: ORG } });
    expect(fileAsset.id).toBe(result.fileAssetId);
    expect(fileAsset.connectionId).toBe(uploadConnectionId);
    expect(fileAsset.kind).toBe('CSV');
    expect(fileAsset.sizeBytes).toBe(body.length);
    expect(fileAsset.storageKey.startsWith(`${ORG}/`)).toBe(true);

    const stored = await storage.get(fileAsset.storageKey, ORG);
    expect(stored.body.equals(body)).toBe(true);

    const batch = await prisma.importBatch.findFirstOrThrow({ where: { organizationId: ORG } });
    expect(batch.id).toBe(result.import.batchId);
    expect(batch.status).toBe('IMPORTED');
    expect(batch.fileAssetId).toBe(fileAsset.id);
    expect(batch.connectionId).toBe(uploadConnectionId);

    expect(await prisma.sourceTransaction.count({ where: { organizationId: ORG } })).toBe(
      result.import.rowsOk,
    );
    const transactions = await prisma.sourceTransaction.findMany({ where: { organizationId: ORG } });
    expect(transactions.every((row) => row.connectionId === uploadConnectionId)).toBe(true);
    expect(transactions.every((row) => row.importBatchId === batch.id)).toBe(true);

    const actions = (
      await prisma.auditLog.findMany({ where: { organizationId: ORG }, orderBy: { createdAt: 'asc' } })
    ).map((row) => row.action);
    expect(actions).toContain('file.uploaded');
    expect(actions).toContain('import.completed');
    const uploadAudit = await prisma.auditLog.findFirstOrThrow({
      where: { organizationId: ORG, action: 'file.uploaded' },
    });
    expect(uploadAudit.actorType).toBe('SYSTEM');
    expect(uploadAudit.actorRef).toBe('acquisition-service');
    expect(uploadAudit.entityId).toBe(fileAsset.id);

    const connection = await prisma.sourceConnection.findUniqueOrThrow({
      where: { id: uploadConnectionId },
    });
    expect(connection.lastSyncAt).not.toBeNull();
    expect(connection.lastError).toBeNull();
  });

  it('接口拉取：走同一 canonical ingest，不创建 FileAsset', async () => {
    const adapter: ExternalAdapter = {
      platform: 'fixture-carrier',
      capabilities: () => ({
        platform: 'fixture-carrier',
        displayName: 'Fixture Carrier',
        domains: ['LOGISTICS'],
        channels: ['UPS'],
        supportsIncrementalPull: false,
        supportsPagination: false,
        supportsClaimSubmission: false,
        maxPageSize: 100,
      }),
      async authenticate() {
        return { platform: 'fixture-carrier', handle: { ok: true } };
      },
      async pull(): Promise<AdapterPullPage> {
        return {
          records: [
            {
              externalId: 'API-1',
              referenceType: 'INVOICE',
              occurredAt: '2026-09-05',
              amount: '88.2500',
              currency: 'USD',
              source: { invoiceId: 'API-1', carrier: 'fixture' },
            },
          ],
          nextCursor: null,
          hasMore: false,
        };
      },
    };

    const result = await runApiAcquisition(
      {
        organizationId: ORG,
        connectionId: apiConnectionId,
        domain: 'LOGISTICS',
        channel: 'UPS',
        credentials: { secretRef: 'CROSSCLAIM_FIXTURE_UPS_RO' },
      },
      { adapter, connections, imports, audit },
    );

    expect(result.import.status).toBe('IMPORTED');
    expect(result.recordsPulled).toBe(1);
    expect(await prisma.sourceTransaction.count({ where: { organizationId: ORG } })).toBe(1);
    expect(await prisma.fileAsset.count({ where: { organizationId: ORG } })).toBe(0);

    const transaction = await prisma.sourceTransaction.findFirstOrThrow({ where: { organizationId: ORG } });
    expect(transaction.connectionId).toBe(apiConnectionId);
    expect(transaction.amount?.toFixed(4)).toBe('88.2500');
    expect((transaction.raw as Record<string, unknown>)._source).toEqual({
      invoiceId: 'API-1',
      carrier: 'fixture',
    });

    const apiAudit = await prisma.auditLog.findFirstOrThrow({
      where: { organizationId: ORG, action: 'import.completed' },
    });
    expect((apiAudit.changes as Record<string, unknown>).source).toBe('API');

    const connection = await prisma.sourceConnection.findUniqueOrThrow({ where: { id: apiConnectionId } });
    expect(connection.lastSyncAt).not.toBeNull();
  });
});
