/**
 * C-0007 Phase 3 — API Connector Runtime guard tests (no database).
 */

import { describe, expect, it } from 'vitest';

import {
  ConnectorRuntimeError,
  runConnectorPull,
  type ConnectorRuntimeDeps,
} from '../services/acquisition';
import {
  createAdapterRegistry,
  type AdapterPullPage,
  type AdapterRegistry,
  type ExternalAdapter,
} from '../services/adapters';
import { createAuditWriter, type AuditLogInsert, type AuditLogRow, type AuditSink } from '../services/audit';
import type { ImportBatchDraft, ImportRepository, TransactionInsert } from '../services/ingest';

const ORG = 'a2000000-0000-4000-8000-000000000001';
const CONNECTION = 'a2000000-0000-4000-8000-0000000000c1';
const SALT = 'gate5-connector-audit-salt-0123456789';

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
  batches: ImportBatchDraft[] = [];
  transactions: TransactionInsert[] = [];
  async createBatch(data: ImportBatchDraft) {
    this.batches.push(data);
    return { id: `batch-${this.batches.length}` };
  }
  async updateBatch() {
    return undefined;
  }
  async insertTransactions(rows: TransactionInsert[]) {
    this.transactions.push(...rows);
    return { inserted: rows.length };
  }
}

const CAPABILITIES = {
  platform: 'fixture-carrier',
  displayName: 'Fixture Carrier',
  domains: ['LOGISTICS'] as const,
  channels: ['UPS'] as const,
  supportsIncrementalPull: false,
  supportsPagination: false,
  supportsClaimSubmission: false as const,
  maxPageSize: 100,
};

function fixtureAdapter(): ExternalAdapter {
  return {
    platform: 'fixture-carrier',
    capabilities: () => ({
      ...CAPABILITIES,
      domains: [...CAPABILITIES.domains],
      channels: [...CAPABILITIES.channels],
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
            source: { invoiceId: 'API-1' },
          },
        ],
        nextCursor: null,
        hasMore: false,
      };
    },
  };
}

function writeAdapter(): ExternalAdapter {
  return {
    ...fixtureAdapter(),
    async submitClaim() {
      return { status: 'SUBMITTED' as const, externalRef: 'x' };
    },
  } as ExternalAdapter;
}

function registryOf(adapter: ExternalAdapter | null): AdapterRegistry {
  if (!adapter) return createAdapterRegistry([]);
  try {
    return createAdapterRegistry([adapter]);
  } catch {
    // Registration refuses a write surface; the runtime must refuse it too, so we
    // inject a registry that still yields the adapter.
    return {
      register: () => undefined,
      get: () => adapter,
      list: () => [adapter],
      byChannel: () => [adapter],
    };
  }
}

function fixture(connection: Record<string, unknown> | null, adapter: ExternalAdapter | null = fixtureAdapter()) {
  const sink = new MemoryAuditSink();
  const imports = new MemoryImportRepository();
  const synced: string[] = [];
  const deps: ConnectorRuntimeDeps = {
    prisma: {
      sourceConnection: { findFirst: async () => connection },
    } as unknown as ConnectorRuntimeDeps['prisma'],
    connections: {
      async find(organizationId, connectionId) {
        if (!connection) return null;
        if (organizationId !== ORG || connectionId !== CONNECTION) return null;
        return {
          id: CONNECTION,
          organizationId: ORG,
          kind: 'API' as const,
          status: 'ACTIVE' as const,
          domain: 'LOGISTICS' as const,
          channel: 'UPS' as const,
        };
      },
      async markSynced(id) {
        synced.push(id);
      },
      async markError() {},
    },
    imports,
    audit: createAuditWriter(sink, { ipSalt: SALT }),
    registry: registryOf(adapter),
    now: () => new Date('2026-09-28T15:00:00Z'),
  };
  return { deps, sink, imports, synced };
}

const activeConnection = {
  id: CONNECTION,
  kind: 'API',
  status: 'ACTIVE',
  credentialRef: 'CROSSCLAIM_FIXTURE_UPS_RO',
  config: { platform: 'fixture-carrier' },
};

const pull = (deps: ConnectorRuntimeDeps) =>
  runConnectorPull(
    { organizationId: ORG, connectionId: CONNECTION, domain: 'LOGISTICS', channel: 'UPS' },
    deps,
  );

describe('C-0007 Phase 3 — connector runtime guards', () => {
  it('refuses a missing, non-API, non-ACTIVE, misconfigured or credential-less connection', async () => {
    await expect(pull(fixture(null).deps)).rejects.toThrow(ConnectorRuntimeError);

    const notApi = fixture({ ...activeConnection, kind: 'FILE_UPLOAD' });
    await expect(pull(notApi.deps)).rejects.toThrow(/连接器只能驱动 API 连接/);

    const paused = fixture({ ...activeConnection, status: 'PAUSED' });
    await expect(pull(paused.deps)).rejects.toThrow(/只有 ACTIVE 允许拉取/);

    const noConfig = fixture({ ...activeConnection, config: {} });
    await expect(pull(noConfig.deps)).rejects.toThrow(/缺少 config.platform/);

    const noCredential = fixture({ ...activeConnection, credentialRef: null });
    await expect(pull(noCredential.deps)).rejects.toThrow(/未配置凭据引用/);
  });

  it('refuses an unregistered platform and an adapter with a write surface', async () => {
    const unknown = fixture({ ...activeConnection, config: { platform: 'unknown-platform' } }, null);
    await expect(pull(unknown.deps)).rejects.toThrow(/未注册适配器/);

    const writer = fixture(activeConnection, writeAdapter());
    await expect(pull(writer.deps)).rejects.toThrow(/实现了写入面/);
  });

  it('pulls through the fixture adapter, imports canonically and audits the run', async () => {
    const { deps, sink, imports, synced } = fixture(activeConnection);
    const result = await pull(deps);

    expect(result.recordsPulled).toBe(1);
    expect(result.import.status).toBe('IMPORTED');
    expect(imports.transactions).toHaveLength(1);
    expect(imports.transactions[0].connectionId).toBe(CONNECTION);
    expect(synced).toEqual([CONNECTION]);

    const actions = sink.rows.map((row) => row.action);
    expect(actions).toContain('import.completed');
    expect(actions).toContain('adapter.pull_completed');

    const completed = sink.rows.find((row) => row.action === 'adapter.pull_completed');
    const changes = completed?.changes as Record<string, unknown>;
    expect(changes.platform).toBe('fixture-carrier');
    expect(changes.recordsPulled).toBe(1);
    expect(changes.importStatus).toBe('IMPORTED');
    // never log the credential reference value
    expect(JSON.stringify(changes)).not.toContain('CROSSCLAIM_FIXTURE_UPS_RO');
  });
});
