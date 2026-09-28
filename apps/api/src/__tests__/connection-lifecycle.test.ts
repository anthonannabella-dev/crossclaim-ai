/**
 * C-0007 Phase 1 — SourceConnection lifecycle unit tests (no database).
 */

import { describe, expect, it } from 'vitest';

import { createAuditWriter, type AuditLogInsert, type AuditLogRow, type AuditSink } from '../services/audit';
import {
  CONNECTION_TRANSITIONS,
  assertTransition,
  canTransition,
  createConnection,
  initialStatusFor,
  markConnectionError,
  rotateCredentialRef,
  transitionConnection,
  type ConnectionLifecyclePort,
  type ConnectionRecord,
} from '../services/acquisition';

const ORG = 'e0000000-0000-4000-8000-000000000001';
const SALT = 'gate5-lifecycle-audit-salt-0123456789';

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

function fixtureRecord(overrides: Partial<ConnectionRecord> = {}): ConnectionRecord {
  return {
    id: 'conn-1',
    organizationId: ORG,
    status: 'NEEDS_AUTH',
    kind: 'API',
    domain: 'LOGISTICS',
    channel: 'UPS',
    label: 'ups api',
    credentialRef: null,
    ...overrides,
  };
}

function fixture(record: ConnectionRecord | null = fixtureRecord()) {
  const sink = new MemoryAuditSink();
  const updates: Array<{ patch: Record<string, unknown> }> = [];
  const created: Array<Record<string, unknown>> = [];
  // Mutable state: the real port persists transitions, the fake must mirror it.
  const state: ConnectionRecord | null = record ? { ...record } : null;

  const port: ConnectionLifecyclePort = {
    async find(organizationId, connectionId) {
      if (!state) return null;
      return organizationId === state.organizationId && connectionId === state.id ? state : null;
    },
    async create(draft) {
      created.push(draft as unknown as Record<string, unknown>);
      return { id: 'conn-new' };
    },
    async update(_organizationId, _connectionId, patch) {
      updates.push({ patch: patch as unknown as Record<string, unknown> });
      if (!state) return;
      if (patch.status !== undefined) state.status = patch.status;
      if (patch.credentialRef !== undefined) state.credentialRef = patch.credentialRef;
    },
  };

  return {
    sink,
    updates,
    created,
    deps: { connections: port, audit: createAuditWriter(sink, { ipSalt: SALT }), now: () => new Date('2026-09-28T14:00:00Z') },
  };
}

describe('C-0007 Phase 1 — connection state machine', () => {
  it('defines an explicit transition table (no arbitrary status strings)', () => {
    expect(CONNECTION_TRANSITIONS.NEEDS_AUTH).toEqual(['ACTIVE', 'REVOKED']);
    expect(CONNECTION_TRANSITIONS.ACTIVE).toContain('PAUSED');
    expect(CONNECTION_TRANSITIONS.PAUSED).toEqual(['ACTIVE', 'REVOKED']);
    expect(CONNECTION_TRANSITIONS.REVOKED).toEqual([]);

    expect(canTransition('NEEDS_AUTH', 'ACTIVE')).toBe(true);
    expect(canTransition('REVOKED', 'ACTIVE')).toBe(false);
    expect(canTransition('NEEDS_AUTH', 'PAUSED')).toBe(false);
    expect(() => assertTransition('REVOKED', 'ACTIVE')).toThrow(/不允许/);
    expect(() => assertTransition('ACTIVE', 'ACTIVE')).not.toThrow();
  });

  it('file upload connections start ACTIVE, API connections start NEEDS_AUTH', () => {
    expect(initialStatusFor('FILE_UPLOAD')).toBe('ACTIVE');
    expect(initialStatusFor('API')).toBe('NEEDS_AUTH');
  });

  it('creates a connection with an audited initial status and no credential value', async () => {
    const { deps, created, sink } = fixture();
    const result = await createConnection(
      {
        organizationId: ORG,
        domain: 'LOGISTICS',
        channel: 'UPS',
        kind: 'API',
        label: 'ups api',
        credentialRef: 'CROSSCLAIM_FIXTURE_UPS_RO',
      },
      deps,
    );

    expect(result).toEqual({ id: 'conn-new', status: 'NEEDS_AUTH' });
    expect(created[0].status).toBe('NEEDS_AUTH');
    expect(sink.rows.map((row) => row.action)).toEqual(['source_connection.created']);
    // Gate 1 sanitizer redacts credential-ish keys as a fail-safe; the contract we
    // care about is that no credential reference value ever reaches the audit row.
    expect(sink.rows[0].changes).toHaveProperty('hasCredentialRef');
    expect(JSON.stringify(sink.rows[0].changes)).not.toContain('CROSSCLAIM_FIXTURE_UPS_RO');
  });

  it('activates, pauses and audits each transition', async () => {
    const { deps, updates, sink } = fixture();

    await transitionConnection({ organizationId: ORG, connectionId: 'conn-1', to: 'ACTIVE' }, deps);
    expect(updates[0].patch.status).toBe('ACTIVE');
    expect(sink.rows[0].action).toBe('source_connection.status_changed');
    expect(sink.rows[0].changes).toMatchObject({ from: 'NEEDS_AUTH', to: 'ACTIVE' });

    await transitionConnection({ organizationId: ORG, connectionId: 'conn-1', to: 'PAUSED' }, deps);
    expect(updates[1].patch.status).toBe('PAUSED');
  });

  it('rejects an illegal transition and writes nothing', async () => {
    const { deps, updates, sink } = fixture(fixtureRecord({ status: 'REVOKED' }));
    await expect(
      transitionConnection({ organizationId: ORG, connectionId: 'conn-1', to: 'ACTIVE' }, deps),
    ).rejects.toThrow(/不允许/);
    expect(updates).toHaveLength(0);
    expect(sink.rows).toHaveLength(0);
  });

  it('rotates a credential reference without logging its value and resets auth when cleared', async () => {
    const { deps, updates, sink } = fixture(fixtureRecord({ status: 'ACTIVE', credentialRef: 'OLD_REF' }));

    await rotateCredentialRef(
      { organizationId: ORG, connectionId: 'conn-1', credentialRef: 'NEW_SECRET_REF' },
      deps,
    );
    expect(updates[0].patch.credentialRef).toBe('NEW_SECRET_REF');
    expect(sink.rows[0].action).toBe('source_connection.credential_rotated');
    expect(JSON.stringify(sink.rows[0].changes)).not.toContain('NEW_SECRET_REF');
    expect(JSON.stringify(sink.rows[0].changes)).not.toContain('OLD_REF');

    await rotateCredentialRef({ organizationId: ORG, connectionId: 'conn-1', credentialRef: null }, deps);
    expect(updates[1].patch.status).toBe('NEEDS_AUTH');
  });

  it('marks a connection as ERROR with lastError and an audit entry', async () => {
    const { deps, updates, sink } = fixture(fixtureRecord({ status: 'ACTIVE' }));
    await markConnectionError(
      { organizationId: ORG, connectionId: 'conn-1', message: 'upstream 503' },
      deps,
    );
    expect(updates[0].patch.status).toBe('ERROR');
    expect(updates[0].patch.lastError).toBe('upstream 503');
    expect(sink.rows[0].changes).toMatchObject({ to: 'ERROR' });
  });
});
