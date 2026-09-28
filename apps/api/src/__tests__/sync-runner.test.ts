/**
 * C-0007 Phase 4 — sync runner unit tests (no database, fake clock).
 *
 * Covers the review's required cases: retry policy/backoff, idempotency of a
 * repeated run, the upload→import-failure→retry→success recovery path, and a
 * partial API pull (page 1 ok / page 2 failed).
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_ATTEMPTS,
  RETRY_BACKOFF_MS,
  backoffForAttempt,
  nextAttemptAt,
  runScheduledSync,
  shouldRetry,
  type SyncRunnerDeps,
} from '../services/acquisition';
import {
  AdapterResponseError,
  createAdapterRegistry,
  type AdapterPullPage,
  type ExternalAdapter,
} from '../services/adapters';
import { createAuditWriter, type AuditLogInsert, type AuditLogRow, type AuditSink } from '../services/audit';
import type { ImportBatchDraft, ImportRepository, TransactionInsert } from '../services/ingest';
import type { StorageAdapter } from '../services/storage';

const ORG = 'a3000000-0000-4000-8000-000000000001';
const CONNECTION = 'a3000000-0000-4000-8000-0000000000c1';
const SALT = 'gate5-runner-audit-salt-0123456789';
const NOW = new Date('2026-09-28T16:00:00Z');
const CSV = ['Invoice No,Invoice Date,Net Charge,Currency', 'INV-9001,2026-09-01,120.0000,USD'].join('\n');

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
  batches: Array<ImportBatchDraft & { id: string; status: string }> = [];
  transactions: TransactionInsert[] = [];
  private readonly seen = new Set<string>();
  failNextInsert = false;

  async createBatch(data: ImportBatchDraft) {
    const id = `batch-${this.batches.length + 1}`;
    this.batches.push({ ...data, id, status: data.status });
    return { id };
  }
  async updateBatch(id: string, data: Partial<ImportBatchDraft>) {
    const batch = this.batches.find((item) => item.id === id);
    if (batch && data.status) batch.status = data.status;
  }
  async insertTransactions(rows: TransactionInsert[]) {
    if (this.failNextInsert) {
      this.failNextInsert = false;
      throw new Error('transient database failure');
    }
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

describe('C-0007 Phase 4 — retry policy', () => {
  it('exponentially backs off 1m / 5m / 15m / 1h and then stops', () => {
    expect(RETRY_BACKOFF_MS).toEqual([60_000, 300_000, 900_000, 3_600_000]);
    expect(backoffForAttempt(1)).toBe(60_000);
    expect(backoffForAttempt(2)).toBe(300_000);
    expect(backoffForAttempt(3)).toBe(900_000);
    expect(backoffForAttempt(4)).toBe(3_600_000);
    expect(backoffForAttempt(5)).toBeNull();
    expect(shouldRetry(4)).toBe(true);
    expect(shouldRetry(5)).toBe(false);
    expect(DEFAULT_MAX_ATTEMPTS).toBe(5);
  });

  it('computes the next attempt with a fake clock (no real waiting)', () => {
    expect(nextAttemptAt(1, NOW)?.toISOString()).toBe('2026-09-28T16:01:00.000Z');
    expect(nextAttemptAt(2, NOW)?.toISOString()).toBe('2026-09-28T16:05:00.000Z');
    expect(nextAttemptAt(5, NOW)).toBeNull();
  });
});

function runnerFixture(options: {
  status?: 'ACTIVE' | 'PAUSED';
  kind?: 'FILE_UPLOAD' | 'API';
  fileAsset?: { id: string; storageKey: string; sha256: string } | null;
  latestBatch?: { id: string; status: string } | null;
  adapter?: ExternalAdapter | null;
}) {
  const sink = new MemoryAuditSink();
  const imports = new MemoryImportRepository();
  const synced: string[] = [];
  const errored: Array<{ id: string; message: string }> = [];
  const status = options.status ?? 'ACTIVE';
  const kind = options.kind ?? 'FILE_UPLOAD';

  const deps: SyncRunnerDeps = {
    prisma: {
      sourceConnection: {
        findFirst: async () => ({
          id: CONNECTION,
          kind,
          status,
          credentialRef: kind === 'API' ? 'CROSSCLAIM_FIXTURE_UPS_RO' : null,
          config: kind === 'API' ? { platform: 'fixture-carrier' } : null,
        }),
      },
      fileAsset: {
        findFirst: async () => options.fileAsset ?? null,
      },
      importBatch: {
        findFirst: async () => options.latestBatch ?? null,
      },
    } as unknown as SyncRunnerDeps['prisma'],
    connections: {
      async find(organizationId, connectionId) {
        if (organizationId !== ORG || connectionId !== CONNECTION) return null;
        return {
          id: CONNECTION,
          organizationId: ORG,
          kind: kind as 'FILE_UPLOAD' | 'API',
          status: 'ACTIVE' as const,
          domain: 'LOGISTICS' as const,
          channel: kind === 'API' ? ('UPS' as const) : ('OTHER' as const),
        };
      },
      async markSynced(id) {
        synced.push(id);
      },
      async markError(id, message) {
        errored.push({ id, message });
      },
    },
    imports,
    audit: createAuditWriter(sink, { ipSalt: SALT }),
    storage: {
      driver: 'local',
      async get() {
        return { body: Buffer.from(CSV, 'utf8'), metadata: { storageKey: 'k', size: CSV.length } };
      },
    } as unknown as StorageAdapter,
    ...(options.adapter !== null
      ? {
          registry: createAdapterRegistry(
            options.adapter ? [options.adapter] : [],
          ),
        }
      : {}),
    now: () => NOW,
  };

  return { deps, sink, imports, synced, errored };
}

const fileAsset = { id: 'asset-1', storageKey: `${ORG}/ab/asset-1`, sha256: 'a'.repeat(64) };

const run = (deps: SyncRunnerDeps, overrides: Record<string, unknown> = {}) =>
  runScheduledSync(
    {
      organizationId: ORG,
      connectionId: CONNECTION,
      domain: 'LOGISTICS',
      channel: 'OTHER',
      ...overrides,
    },
    deps,
  );

describe('C-0007 Phase 4 — file import recovery', () => {
  it('fails the first attempt, schedules the 1m retry, then succeeds without duplicates', async () => {
    const fixture = runnerFixture({ fileAsset, latestBatch: { id: 'batch-old', status: 'FAILED' } });
    fixture.imports.failNextInsert = true;

    const first = await run(fixture.deps);
    expect(first.status).toBe('FAILED');
    expect(first.nextAttemptAt).toBe('2026-09-28T16:01:00.000Z');
    expect(fixture.imports.transactions).toHaveLength(0);
    expect(fixture.errored).toHaveLength(1);
    expect(
      fixture.sink.rows.filter((row) => row.action === 'sync_run.failed'),
    ).toHaveLength(1);

    const second = await run(fixture.deps, { attempt: 2 });
    expect(second.status).toBe('SUCCEEDED');
    expect(second.import?.rowsOk).toBe(1);
    expect(fixture.imports.transactions).toHaveLength(1);
    expect(fixture.synced).toEqual([CONNECTION]);

    // idempotent re-run of the same asset
    const third = await run(fixture.deps, { attempt: 3 });
    expect(third.status).toBe('SUCCEEDED');
    expect(fixture.imports.transactions).toHaveLength(1);
  });

  it('is blocked while the connection is not ACTIVE and skips when nothing is pending', async () => {
    const paused = runnerFixture({ status: 'PAUSED', fileAsset });
    const blocked = await run(paused.deps);
    expect(blocked.status).toBe('BLOCKED');
    expect(blocked.detail).toBe('CONNECTION_PAUSED');
    expect(paused.sink.rows).toHaveLength(0);

    const noAsset = runnerFixture({ fileAsset: null });
    const skipped = await run(noAsset.deps);
    expect(skipped.status).toBe('SKIPPED');
    expect(skipped.detail).toBe('NO_FILE_ASSET');

    const alreadyDone = runnerFixture({ fileAsset, latestBatch: { id: 'batch-1', status: 'IMPORTED' } });
    const done = await run(alreadyDone.deps);
    expect(done.status).toBe('SKIPPED');
    expect(done.detail).toBe('ALREADY_IMPORTED');
  });
});

describe('C-0007 Phase 4 — API runner', () => {
  const adapterWithPartialFailure = (): ExternalAdapter => {
    let call = 0;
    return {
      platform: 'fixture-carrier',
      capabilities: () => ({
        ...CAPABILITIES,
        domains: [...CAPABILITIES.domains],
        channels: [...CAPABILITIES.channels],
      }),
      async authenticate() {
        return { platform: 'fixture-carrier', handle: {} };
      },
      async pull(): Promise<AdapterPullPage> {
        call += 1;
        // The second page of the first run fails; later runs return the same row.
        if (call === 2) throw new AdapterResponseError('page 2 failed', 503);
        return {
          records: [
            {
              externalId: 'API-1',
              referenceType: 'INVOICE',
              occurredAt: '2026-09-01',
              amount: '100.0000',
              currency: 'USD',
              source: { id: 'API-1' },
            },
          ],
          nextCursor: call === 1 ? 'page-2' : null,
          hasMore: call === 1,
        };
      },
    };
  };

  it('keeps page-1 data on a partial pull and does not duplicate on retry', async () => {
    const fixture = runnerFixture({
      kind: 'API',
      adapter: adapterWithPartialFailure(),
    });

    const first = await run(fixture.deps, { channel: 'UPS' });
    expect(first.status).toBe('SUCCEEDED');
    expect(first.pull?.recordsPulled).toBe(1);
    expect(first.import?.rowsOk).toBe(1);
    expect(fixture.imports.transactions).toHaveLength(1);
    expect(
      fixture.sink.rows.some((row) => row.action === 'adapter.pull_failed'),
    ).toBe(true);

    const second = await run(fixture.deps, { channel: 'UPS', attempt: 2 });
    expect(second.status).toBe('SUCCEEDED');
    expect(fixture.imports.transactions).toHaveLength(1);
  });
});
