/**
 * C-0005 / Gate 3 — dual-mode acquisition unit tests (no database required).
 * ---------------------------------------------------------------
 * Proves the acquisition boundaries:
 *   - FILE_UPLOAD: tenant-scoped storage key, FileAsset then import, audit events
 *   - API: read-only adapter pull, import outcome, adapter.pull_failed on failure
 *   - both share the Gate 1 audit safety path (validation + redaction)
 *   - both refuse a SourceConnection of the wrong kind / tenant
 */

import { describe, expect, it } from 'vitest';

import {
  AdapterRateLimitError,
  AdapterResponseError,
  type AdapterPullPage,
  type AdapterRecord,
  type AdapterSession,
  type ExternalAdapter,
} from '../services/adapters';
import { REDACTED, createAuditWriter, type AuditLogInsert, type AuditLogRow, type AuditSink } from '../services/audit';
import {
  AcquisitionError,
  runApiAcquisition,
  uploadFileAndImport,
  type FileAssetDraft,
  type FileUploadDeps,
} from '../services/acquisition';
import type { ImportBatchDraft, ImportRepository, TransactionInsert } from '../services/ingest';
import {
  buildStorageKey,
  sha256Hex,
  type StorageAdapter,
  type StoragePutInput,
} from '../services/storage';

const ORG = '44444444-4444-4444-8444-444444444444';
const OTHER_ORG = '55555555-5555-4555-8555-555555555555';
const UPLOAD_CONNECTION = 'aaaaaaaa-1111-4111-8111-111111111111';
const API_CONNECTION = 'bbbbbbbb-2222-4222-8222-222222222222';
const SALT = 'unit-test-audit-salt-0123456789';

const CSV = [
  'Invoice No,Tracking Number,Invoice Date,Net Charge,Currency',
  'INV-1,1Z999,2026-09-01,100.50,USD',
  'INV-2,1Z888,2026-09-02,200.00,USD',
].join('\n');

const BAD_CSV = [
  'Invoice No,Tracking Number,Invoice Date,Net Charge,Currency',
  'INV-3,1Z777,2026-09-03,not-a-number,USD',
].join('\n');

class MemoryAuditSink implements AuditSink {
  rows: AuditLogInsert[] = [];

  async insert(row: AuditLogInsert) {
    this.rows.push(row);
    return { id: `audit-${this.rows.length}`, createdAt: row.createdAt };
  }

  async query(): Promise<AuditLogRow[]> {
    return [];
  }
}

class MemoryImportRepository implements ImportRepository {
  batches: Array<ImportBatchDraft & { id: string }> = [];
  transactions: TransactionInsert[] = [];
  private readonly seen = new Set<string>();

  async createBatch(data: ImportBatchDraft) {
    const id = `batch-${this.batches.length + 1}`;
    this.batches.push({ ...data, id });
    return { id };
  }

  async updateBatch(id: string, data: Partial<ImportBatchDraft>) {
    const batch = this.batches.find((item) => item.id === id);
    if (!batch) throw new Error(`unknown batch ${id}`);
    Object.assign(batch, data);
  }

  async insertTransactions(rows: TransactionInsert[]) {
    let inserted = 0;
    for (const row of rows) {
      if (this.seen.has(row.dedupeKey)) continue;
      this.seen.add(row.dedupeKey);
      this.transactions.push(row);
      inserted += 1;
    }
    return { inserted };
  }
}

function fakeStorage(onPut?: (input: StoragePutInput) => void): StorageAdapter {
  return {
    driver: 'local',
    async put(input) {
      const sha256 = sha256Hex(input.body);
      if (input.expectedSha256 && input.expectedSha256 !== sha256) {
        throw new Error('sha256 mismatch');
      }
      onPut?.(input);
      return {
        storageKey: buildStorageKey({
          organizationId: input.organizationId,
          fileAssetId: input.fileAssetId,
          sha256,
        }),
        size: input.body.length,
        sha256,
      };
    },
    async get() {
      throw new Error('not used in unit tests');
    },
    async head() {
      return null;
    },
    async createSignedUrl() {
      throw new Error('not used in unit tests');
    },
    async openSignedUrl() {
      throw new Error('not used in unit tests');
    },
  };
}

function fakeConnections() {
  const synced: string[] = [];
  const errored: Array<{ id: string; message: string }> = [];
  return {
    synced,
    errored,
    port: {
      async find(organizationId: string, connectionId: string) {
        if (organizationId !== ORG) return null;
        if (connectionId === UPLOAD_CONNECTION) {
          return {
            id: UPLOAD_CONNECTION,
            organizationId: ORG,
            kind: 'FILE_UPLOAD' as const,
            status: 'ACTIVE' as const,
            domain: 'LOGISTICS' as const,
            channel: 'OTHER' as const,
          };
        }
        if (connectionId === API_CONNECTION) {
          return {
            id: API_CONNECTION,
            organizationId: ORG,
            kind: 'API' as const,
            status: 'ACTIVE' as const,
            domain: 'LOGISTICS' as const,
            channel: 'UPS' as const,
          };
        }
        return null;
      },
      async markSynced(connectionId: string) {
        synced.push(connectionId);
      },
      async markError(connectionId: string, message: string) {
        errored.push({ id: connectionId, message });
      },
    },
  };
}

function fakeFileAssets() {
  const drafts: FileAssetDraft[] = [];
  return {
    drafts,
    port: {
      async create(draft: FileAssetDraft) {
        drafts.push(draft);
        return { id: draft.id };
      },
    },
  };
}

const CAPABILITIES = {
  platform: 'fixture-carrier',
  displayName: 'Fixture Carrier',
  domains: ['LOGISTICS'] as const,
  channels: ['UPS'] as const,
  supportsIncrementalPull: false,
  supportsPagination: true,
  supportsClaimSubmission: false as const,
  maxPageSize: 100,
};

function fakeAdapter(pull: () => Promise<AdapterPullPage>): ExternalAdapter {
  return {
    platform: 'fixture-carrier',
    capabilities: () => ({ ...CAPABILITIES, domains: [...CAPABILITIES.domains], channels: [...CAPABILITIES.channels] }),
    async authenticate(): Promise<AdapterSession> {
      return { platform: 'fixture-carrier', handle: { ok: true } };
    },
    pull,
  };
}

const RECORDS: AdapterRecord[] = [
  { externalId: 'INV-1', referenceType: 'INVOICE', occurredAt: '2026-09-01', amount: '100.50', currency: 'USD', source: { carrier: 'fixture' } },
  { externalId: 'INV-2', referenceType: 'INVOICE', occurredAt: '2026-09-02', amount: '200.00', currency: 'USD', source: { carrier: 'fixture' } },
];

function fileUploadFixture(overrides: Partial<FileUploadDeps> = {}) {
  const sink = new MemoryAuditSink();
  const connections = fakeConnections();
  const fileAssets = fakeFileAssets();
  const imports = new MemoryImportRepository();
  const puts: StoragePutInput[] = [];

  const deps = {
    connections: connections.port,
    fileAssets: fileAssets.port,
    storage: fakeStorage((input) => puts.push(input)),
    imports,
    audit: createAuditWriter(sink, { ipSalt: SALT }),
    now: () => new Date('2026-09-28T00:00:00Z'),
    ...overrides,
  };

  return { deps, sink, connections, fileAssets, imports, puts };
}

describe('C-0005 / Gate 3 — FILE_UPLOAD acquisition', () => {
  it('stores bytes, registers a FileAsset, imports rows and audits both events', async () => {
    const { deps, sink, connections, fileAssets, imports, puts } = fileUploadFixture();

    const result = await uploadFileAndImport(
      {
        organizationId: ORG,
        connectionId: UPLOAD_CONNECTION,
        domain: 'LOGISTICS',
        channel: 'OTHER',
        kind: 'CSV',
        originalName: 'carrier-invoice.csv',
        mimeType: 'text/csv',
        body: Buffer.from(CSV, 'utf8'),
      },
      deps,
    );

    expect(result.import.status).toBe('IMPORTED');
    expect(result.import.rowsOk).toBe(2);
    expect(imports.transactions).toHaveLength(2);
    expect(imports.transactions[0].connectionId).toBe(UPLOAD_CONNECTION);
    expect(imports.transactions[0].importBatchId).toBe(result.import.batchId);

    expect(puts).toHaveLength(1);
    expect(puts[0].organizationId).toBe(ORG);
    expect(puts[0].fileAssetId).toBe(result.fileAssetId);

    expect(fileAssets.drafts).toHaveLength(1);
    const draft = fileAssets.drafts[0];
    expect(draft.storageKey.startsWith(`${ORG}/`)).toBe(true);
    expect(draft.connectionId).toBe(UPLOAD_CONNECTION);
    expect(draft.kind).toBe('CSV');
    expect(draft.sha256).toBe(sha256Hex(Buffer.from(CSV, 'utf8')));

    expect(sink.rows.map((row) => row.action)).toEqual(['file.uploaded', 'import.completed']);
    for (const row of sink.rows) {
      expect(row.actorType).toBe('SYSTEM');
      expect(row.actorRef).toBe('acquisition-service');
      expect(row.organizationId).toBe(ORG);
    }
    expect(sink.rows[1].entityId).toBe(result.import.batchId);
    expect((sink.rows[1].changes as Record<string, unknown>).source).toBe('FILE_UPLOAD');
    expect(connections.synced).toEqual([UPLOAD_CONNECTION]);
    expect(connections.errored).toHaveLength(0);
  });

  it('audits import.failed and marks the connection when every row is invalid', async () => {
    const { deps, sink, connections } = fileUploadFixture();

    const result = await uploadFileAndImport(
      {
        organizationId: ORG,
        connectionId: UPLOAD_CONNECTION,
        domain: 'LOGISTICS',
        channel: 'OTHER',
        kind: 'CSV',
        originalName: 'bad.csv',
        body: Buffer.from(BAD_CSV, 'utf8'),
      },
      deps,
    );

    expect(result.import.status).toBe('FAILED');
    expect(sink.rows.map((row) => row.action)).toEqual(['file.uploaded', 'import.failed']);
    expect(connections.synced).toHaveLength(0);
    expect(connections.errored).toHaveLength(1);
  });

  it('audits file.upload_failed and creates no FileAsset when storage rejects the write', async () => {
    const failing = fakeStorage(() => {
      throw new Error('disk full');
    });
    const { deps, sink, fileAssets } = fileUploadFixture({ storage: failing });

    await expect(
      uploadFileAndImport(
        {
          organizationId: ORG,
          connectionId: UPLOAD_CONNECTION,
          domain: 'LOGISTICS',
          channel: 'OTHER',
          kind: 'CSV',
          originalName: 'x.csv',
          body: Buffer.from(CSV, 'utf8'),
        },
        deps,
      ),
    ).rejects.toThrow(/disk full/);

    expect(fileAssets.drafts).toHaveLength(0);
    expect(sink.rows.map((row) => row.action)).toEqual(['file.upload_failed']);
    expect((sink.rows[0].changes as { failure: { message: string } }).failure.message).toBe('disk full');
  });

  it('refuses a connection of another kind and writes nothing', async () => {
    const { deps, sink, puts, fileAssets } = fileUploadFixture();

    await expect(
      uploadFileAndImport(
        {
          organizationId: ORG,
          connectionId: API_CONNECTION,
          domain: 'LOGISTICS',
          channel: 'OTHER',
          kind: 'CSV',
          originalName: 'x.csv',
          body: Buffer.from(CSV, 'utf8'),
        },
        deps,
      ),
    ).rejects.toThrow(AcquisitionError);

    expect(sink.rows).toHaveLength(0);
    expect(fileAssets.drafts).toHaveLength(0);
    expect(puts).toHaveLength(0);
  });

  it('fails closed on an empty body and on unsupported file kinds', async () => {
    const { deps } = fileUploadFixture();
    const base = {
      organizationId: ORG,
      connectionId: UPLOAD_CONNECTION,
      domain: 'LOGISTICS' as const,
      channel: 'OTHER' as const,
      originalName: 'x.csv',
    };

    await expect(uploadFileAndImport({ ...base, kind: 'CSV', body: Buffer.alloc(0) }, deps)).rejects.toThrow(
      /为空/,
    );
    await expect(
      uploadFileAndImport({ ...base, kind: 'PDF', body: Buffer.from('%PDF-1.7', 'utf8') }, deps),
    ).rejects.toThrow(/CSV/);
  });

  it('treats a foreign tenant as not found', async () => {
    const { deps } = fileUploadFixture();

    await expect(
      uploadFileAndImport(
        {
          organizationId: OTHER_ORG,
          connectionId: UPLOAD_CONNECTION,
          domain: 'LOGISTICS',
          channel: 'OTHER',
          kind: 'CSV',
          originalName: 'x.csv',
          body: Buffer.from(CSV, 'utf8'),
        },
        deps,
      ),
    ).rejects.toThrow(/不存在/);
  });
});

function apiFixture(pull: () => Promise<AdapterPullPage>) {
  const sink = new MemoryAuditSink();
  const connections = fakeConnections();
  const imports = new MemoryImportRepository();
  const deps = {
    adapter: fakeAdapter(pull),
    connections: connections.port,
    imports,
    audit: createAuditWriter(sink, { ipSalt: SALT }),
    now: () => new Date('2026-09-28T00:00:00Z'),
  };
  return { deps, sink, connections, imports };
}

describe('C-0005 / Gate 3 — API acquisition', () => {
  it('imports pulled records through canonical ingest and audits import.completed', async () => {
    const { deps, sink, connections, imports } = apiFixture(async () => ({
      records: RECORDS,
      nextCursor: null,
      hasMore: false,
    }));

    const result = await runApiAcquisition(
      {
        organizationId: ORG,
        connectionId: API_CONNECTION,
        domain: 'LOGISTICS',
        channel: 'UPS',
        credentials: { secretRef: 'CROSSCLAIM_FIXTURE_CARRIER_RO' },
      },
      deps,
    );

    expect(result.import.status).toBe('IMPORTED');
    expect(result.recordsPulled).toBe(2);
    expect(imports.transactions).toHaveLength(2);
    expect(imports.transactions[0].connectionId).toBe(API_CONNECTION);

    expect(sink.rows.map((row) => row.action)).toEqual(['import.completed']);
    expect((sink.rows[0].changes as Record<string, unknown>).source).toBe('API');
    expect((sink.rows[0].changes as Record<string, unknown>).platform).toBe('fixture-carrier');
    expect(connections.synced).toEqual([API_CONNECTION]);
  });

  it('audits adapter.pull_failed, marks the connection and rethrows when nothing was pulled', async () => {
    const { deps, sink, connections } = apiFixture(async () => {
      throw new AdapterResponseError('upstream 503', 503);
    });

    await expect(
      runApiAcquisition(
        {
          organizationId: ORG,
          connectionId: API_CONNECTION,
          domain: 'LOGISTICS',
          channel: 'UPS',
          credentials: { secretRef: 'CROSSClAIM_FIXTURE_CARRIER_RO' },
        },
        deps,
      ),
    ).rejects.toThrow(AdapterResponseError);

    expect(sink.rows.map((row) => row.action)).toEqual(['adapter.pull_failed']);
    const changes = sink.rows[0].changes as { failure: { code: string } };
    expect(changes.failure.code).toBe('RESPONSE_ERROR');
    expect(connections.errored).toHaveLength(1);
  });

  it('records a partial pull failure and still imports the records already fetched', async () => {
    let call = 0;
    const { deps, sink } = apiFixture(async () => {
      call += 1;
      if (call === 1) {
        return { records: RECORDS, nextCursor: 'page-2', hasMore: true };
      }
      throw new AdapterRateLimitError('rate limited', 5000);
    });

    const result = await runApiAcquisition(
      {
        organizationId: ORG,
        connectionId: API_CONNECTION,
        domain: 'LOGISTICS',
        channel: 'UPS',
        credentials: { secretRef: 'CROSSCLAIM_FIXTURE_CARRIER_RO' },
      },
      deps,
    );

    expect(result.import.status).toBe('IMPORTED');
    expect(result.recordsPulled).toBe(2);
    expect(result.pullError?.code).toBe('RATE_LIMITED');
    expect(sink.rows.map((row) => row.action)).toEqual(['adapter.pull_failed', 'import.completed']);
    expect((sink.rows[0].changes as Record<string, unknown>).partial).toBe(true);
  });

  it('refuses an API pull through a FILE_UPLOAD connection', async () => {
    const { deps, sink } = apiFixture(async () => ({ records: RECORDS, nextCursor: null, hasMore: false }));

    await expect(
      runApiAcquisition(
        {
          organizationId: ORG,
          connectionId: UPLOAD_CONNECTION,
          domain: 'LOGISTICS',
          channel: 'UPS',
          credentials: { secretRef: 'CROSSCLAIM_FIXTURE_CARRIER_RO' },
        },
        deps,
      ),
    ).rejects.toThrow(AcquisitionError);
    expect(sink.rows).toHaveLength(0);
  });

  it('redacts secret-looking failure details through the shared audit writer', async () => {
    const { deps, sink } = apiFixture(async () => {
      throw new AdapterResponseError('sk-abcdefgh12345678', 500);
    });

    await expect(
      runApiAcquisition(
        {
          organizationId: ORG,
          connectionId: API_CONNECTION,
          domain: 'LOGISTICS',
          channel: 'UPS',
          credentials: { secretRef: 'CROSSCLAIM_FIXTURE_CARRIER_RO' },
        },
        deps,
      ),
    ).rejects.toThrow(AdapterResponseError);

    const changes = sink.rows[0].changes as { failure: { message: string } };
    expect(changes.failure.message).toBe(REDACTED);
  });
});

describe('C-0005 / Gate 3 — ingest core is shared by both modes', () => {
  it('produces the same SourceTransaction dedupe key shape for file and API ingestion', async () => {
    const file = fileUploadFixture();
    const api = apiFixture(async () => ({ records: RECORDS, nextCursor: null, hasMore: false }));

    await uploadFileAndImport(
      {
        organizationId: ORG,
        connectionId: UPLOAD_CONNECTION,
        domain: 'LOGISTICS',
        channel: 'UPS',
        kind: 'CSV',
        originalName: 'carrier-invoice.csv',
        body: Buffer.from(CSV, 'utf8'),
      },
      file.deps,
    );
    await runApiAcquisition(
      {
        organizationId: ORG,
        connectionId: API_CONNECTION,
        domain: 'LOGISTICS',
        channel: 'UPS',
        credentials: { secretRef: 'CROSSCLAIM_FIXTURE_CARRIER_RO' },
      },
      api.deps,
    );

    const fileKeys = file.imports.transactions.map((row) => row.dedupeKey);
    const apiKeys = api.imports.transactions.map((row) => row.dedupeKey);
    expect(fileKeys).toHaveLength(2);
    expect(apiKeys).toHaveLength(2);
    // Same business rows, different connections → separate raw sources (no silent merge).
    expect(new Set([...fileKeys, ...apiKeys]).size).toBe(4);
    expect(fileKeys.every((key) => /^[0-9a-f]{64}$/.test(key))).toBe(true);
    expect(apiKeys.every((key) => /^[0-9a-f]{64}$/.test(key))).toBe(true);
  });

  it('keeps FileAsset out of the Evidence table (a FileAsset is not Evidence)', async () => {
    const { deps, sink } = fileUploadFixture();

    await uploadFileAndImport(
      {
        organizationId: ORG,
        connectionId: UPLOAD_CONNECTION,
        domain: 'LOGISTICS',
        channel: 'OTHER',
        kind: 'CSV',
        originalName: 'carrier-invoice.csv',
        body: Buffer.from(CSV, 'utf8'),
      },
      deps,
    );

    const actions = sink.rows.map((row) => row.action);
    expect(actions).not.toContain('evidence.created');
    expect(sink.rows.every((row) => row.entityType !== 'EvidenceArtifact')).toBe(true);
  });
});
