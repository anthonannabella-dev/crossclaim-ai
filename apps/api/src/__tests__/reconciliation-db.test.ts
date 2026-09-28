/**
 * C-0005 / Gate 3 — cross-source reconciliation against real PostgreSQL.
 * ---------------------------------------------------------------
 * End-to-end proof that the same invoice arriving through FILE_UPLOAD and
 * through an API connection is
 *   - counted once when both sources agree (never double-counted recovery), and
 *   - turned into SOURCE_CONFLICT (fail closed) when the values disagree,
 * while both raw SourceTransaction rows are preserved.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createPrismaFileAssetPort,
  createPrismaSourceConnectionPort,
  runApiAcquisition,
  uploadFileAndImport,
} from '../services/acquisition';
import type { AdapterPullPage, ExternalAdapter } from '../services/adapters';
import { createAuditWriter, createPrismaAuditSink } from '../services/audit';
import { createPrismaImportRepository } from '../services/ingest';
import {
  SourceConflictError,
  assertNoSourceConflict,
  createPrismaReconciliationRepository,
  reconcileSourceFacts,
} from '../services/reconciliation';
import { LocalFileSystemStorage } from '../services/storage';

const prisma = new PrismaClient();
const ORG = '77777777-7777-4777-8777-777777777777';
const SALT = 'gate3-reconciliation-audit-salt-012345';

const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-recon-'));
const storage = new LocalFileSystemStorage({
  rootDir: storageRoot,
  secret: SALT,
  publicBaseUrl: 'http://localhost:3000',
});

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const imports = createPrismaImportRepository(prisma);
const connections = createPrismaSourceConnectionPort(prisma);
const fileAssets = createPrismaFileAssetPort(prisma);
const reconciliation = createPrismaReconciliationRepository(prisma);

let uploadConnectionId = '';
let apiConnectionId = '';

const CSV_HEADER = 'Invoice No,Tracking Number,Invoice Date,Net Charge,Currency';

function apiAdapter(amount: string): ExternalAdapter {
  return {
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
            externalId: 'INV-9001',
            referenceType: 'INVOICE',
            occurredAt: '2026-09-08',
            amount,
            currency: 'USD',
            source: { invoiceId: 'INV-9001' },
          },
        ],
        nextCursor: null,
        hasMore: false,
      };
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
    'TRUNCATE TABLE "AuditLog", "SourceTransaction", "ImportBatch", "FileAsset", "SourceConnection", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: '对账租户', slug: 'recon-org' } });
  const upload = await prisma.sourceConnection.create({
    data: {
      organizationId: ORG,
      domain: 'LOGISTICS',
      channel: 'UPS',
      kind: 'FILE_UPLOAD',
      status: 'ACTIVE',
      label: 'invoice upload',
    },
  });
  uploadConnectionId = upload.id;
  const api = await prisma.sourceConnection.create({
    data: {
      organizationId: ORG,
      domain: 'LOGISTICS',
      channel: 'UPS',
      kind: 'API',
      status: 'ACTIVE',
      label: 'ups api',
    },
  });
  apiConnectionId = api.id;
});

async function ingestFile(amount: string) {
  const csv = [`${CSV_HEADER}`, `INV-9001,1ZDEMO900,2026-09-08,${amount},USD`].join('\n');
  return uploadFileAndImport(
    {
      organizationId: ORG,
      connectionId: uploadConnectionId,
      domain: 'LOGISTICS',
      channel: 'UPS',
      kind: 'CSV',
      originalName: 'recon.csv',
      body: Buffer.from(csv, 'utf8'),
    },
    { connections, fileAssets, storage, imports, audit },
  );
}

async function ingestApi(amount: string) {
  return runApiAcquisition(
    {
      organizationId: ORG,
      connectionId: apiConnectionId,
      domain: 'LOGISTICS',
      channel: 'UPS',
      credentials: { secretRef: 'CROSSCLAIM_FIXTURE_UPS_RO' },
    },
    { adapter: apiAdapter(amount), connections, imports, audit },
  );
}

describe('C-0005 / Gate 3 — cross-source reconciliation（真实 PostgreSQL）', () => {
  it('同一张账单同时来自上传与接口且金额一致 → 记为 1 个事实、两条原始来源', async () => {
    await ingestFile('250.0000');
    await ingestApi('250.0000');

    expect(await prisma.sourceTransaction.count({ where: { organizationId: ORG } })).toBe(2);

    const result = reconcileSourceFacts(
      await reconciliation.load({ organizationId: ORG, domain: 'LOGISTICS', channel: 'UPS' }),
    );

    expect(result.status).toBe('OK');
    expect(result.facts).toHaveLength(1);
    const fact = result.facts[0];
    expect(fact.transactionIds).toHaveLength(2);
    expect(fact.modes).toEqual({ FILE_UPLOAD: 1, API: 1, OTHER: 0 });
    expect(fact.confirmedAcrossModes).toBe(true);
    expect(fact.amount).toBe('250');
    expect(() => assertNoSourceConflict(result)).not.toThrow();
  });

  it('同一张账单金额冲突 → SOURCE_CONFLICT fail closed，原始行仍保留', async () => {
    await ingestFile('250.0000');
    await ingestApi('260.0000');

    const result = reconcileSourceFacts(
      await reconciliation.load({ organizationId: ORG, domain: 'LOGISTICS', channel: 'UPS' }),
    );

    expect(result.status).toBe('CONFLICT');
    expect(result.facts).toHaveLength(0);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].reason).toBe('AMOUNT_MISMATCH');
    expect(() => assertNoSourceConflict(result)).toThrow(SourceConflictError);

    // no raw evidence is destroyed by a conflict
    expect(await prisma.sourceTransaction.count({ where: { organizationId: ORG } })).toBe(2);
    expect(await prisma.fileAsset.count({ where: { organizationId: ORG } })).toBe(1);
  });
});
