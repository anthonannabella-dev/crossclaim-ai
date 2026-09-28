/**
 * C-0005 / Gate 3 — evidence promotion unit tests (no database needed).
 * ---------------------------------------------------------------
 * A FileAsset is not Evidence: evidence only exists after an explicit promotion,
 * promotion is idempotent for the same snapshot + kind, and a case link must
 * belong to the same tenant.
 */

import { describe, expect, it } from 'vitest';

import { createAuditWriter, type AuditLogInsert, type AuditLogRow, type AuditSink } from '../services/audit';
import {
  EvidencePromotionError,
  promoteEvidence,
  type EvidenceDraft,
  type EvidencePromotionPorts,
  type FileAssetSnapshot,
} from '../services/evidence';

const ORG = '44444444-4444-4444-8444-444444444444';
const OTHER_ORG = '55555555-5555-4555-8555-555555555555';
const FILE_ASSET = 'cccccccc-3333-4333-8333-333333333333';
const CASE = 'dddddddd-4444-4444-8444-444444444444';
const SALT = 'unit-test-audit-salt-0123456789';

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

const FILE_ASSET_ROW: FileAssetSnapshot = {
  id: FILE_ASSET,
  organizationId: ORG,
  connectionId: 'aaaaaaaa-1111-4111-8111-111111111111',
  kind: 'CSV',
  originalName: 'carrier-invoice.csv',
  createdAt: new Date('2026-09-28T00:00:00Z'),
};

function fixture(overrides: { evidenceExists?: boolean; caseOwner?: string | null; fileAsset?: FileAssetSnapshot | null } = {}) {
  const sink = new MemoryAuditSink();
  const created: EvidenceDraft[] = [];
  const links: Array<{ caseId: string; evidenceId: string; role: string }> = [];
  const findExistingCalls: string[] = [];

  const deps: EvidencePromotionPorts = {
    fileAssets: {
      async find(organizationId, fileAssetId) {
        if (overrides.fileAsset === null) return null;
        if (overrides.fileAsset) return overrides.fileAsset;
        if (organizationId !== ORG || fileAssetId !== FILE_ASSET) return null;
        return FILE_ASSET_ROW;
      },
    },
    evidence: {
      async findExisting(_organizationId, fileAssetId) {
        findExistingCalls.push(fileAssetId);
        return overrides.evidenceExists ? { id: 'existing-evidence' } : null;
      },
      async create(draft) {
        created.push(draft);
        return { id: `evidence-${created.length}` };
      },
      async linkCase(input) {
        links.push({ caseId: input.caseId, evidenceId: input.evidenceId, role: input.role });
      },
    },
    cases: {
      async find(organizationId, caseId) {
        const owner = overrides.caseOwner === undefined ? ORG : overrides.caseOwner;
        if (owner === null) return null;
        return organizationId === owner && caseId === CASE ? { id: CASE } : null;
      },
    },
    audit: createAuditWriter(sink, { ipSalt: SALT }),
    now: () => new Date('2026-09-28T12:00:00Z'),
  };

  return { deps, sink, created, links, findExistingCalls };
}

describe('C-0005 / Gate 3 — evidence promotion', () => {
  it('promotes a stored snapshot into claim-grade evidence', async () => {
    const { deps, sink, created } = fixture();

    const result = await promoteEvidence(
      {
        organizationId: ORG,
        kind: 'INVOICE',
        title: 'Carrier invoice snapshot INV-1001',
        source: { type: 'FILE_ASSET', fileAssetId: FILE_ASSET },
        caseId: CASE,
        role: 'INVOICE',
      },
      deps,
    );

    expect(result.reused).toBe(false);
    expect(result.caseLinked).toBe(true);
    expect(result.fileAssetId).toBe(FILE_ASSET);
    expect(result.connectionId).toBe(FILE_ASSET_ROW.connectionId);

    expect(created).toHaveLength(1);
    expect(created[0].capturedAt).toEqual(FILE_ASSET_ROW.createdAt);
    expect(created[0].fileAssetId).toBe(FILE_ASSET);
    expect(created[0].externalUrl).toBeNull();

    expect(sink.rows.map((row) => row.action)).toEqual(['evidence.created', 'evidence.case_linked']);
    for (const row of sink.rows) {
      expect(row.actorType).toBe('SYSTEM');
      expect(row.actorRef).toBe('evidence-promotion-service');
      expect(row.organizationId).toBe(ORG);
    }
  });

  it('reuses an existing promotion for the same snapshot and kind', async () => {
    const { deps, sink, created, findExistingCalls } = fixture({ evidenceExists: true });

    const result = await promoteEvidence(
      {
        organizationId: ORG,
        kind: 'INVOICE',
        title: 'Carrier invoice snapshot INV-1001',
        source: { type: 'FILE_ASSET', fileAssetId: FILE_ASSET },
      },
      deps,
    );

    expect(result.reused).toBe(true);
    expect(result.evidenceId).toBe('existing-evidence');
    expect(created).toHaveLength(0);
    expect(findExistingCalls).toEqual([FILE_ASSET]);
    expect(sink.rows.map((row) => row.action)).toEqual(['evidence.promotion_reused']);
  });

  it('promotes an external reference without materialising a FileAsset', async () => {
    const { deps, sink, created } = fixture();

    const result = await promoteEvidence(
      {
        organizationId: ORG,
        kind: 'TRACKING',
        title: 'Carrier portal tracking page',
        source: { type: 'EXTERNAL', externalUrl: 'https://carrier.example/track/1ZDEMO001' },
      },
      deps,
    );

    expect(result.fileAssetId).toBeNull();
    expect(created).toHaveLength(1);
    expect(created[0].fileAssetId).toBeNull();
    expect(created[0].externalUrl).toBe('https://carrier.example/track/1ZDEMO001');
    expect(sink.rows.map((row) => row.action)).toEqual(['evidence.created']);
  });

  it('refuses an unknown FileAsset and creates nothing', async () => {
    const { deps, sink, created } = fixture();

    await expect(
      promoteEvidence(
        {
          organizationId: ORG,
          kind: 'INVOICE',
          title: 'missing snapshot',
          source: { type: 'FILE_ASSET', fileAssetId: 'eeeeeeee-5555-4555-8555-555555555555' },
        },
        deps,
      ),
    ).rejects.toThrow(EvidencePromotionError);
    expect(created).toHaveLength(0);
    expect(sink.rows).toHaveLength(0);
  });

  it('refuses a cross-tenant case link before creating evidence', async () => {
    const { deps, sink, created } = fixture({ caseOwner: OTHER_ORG });

    await expect(
      promoteEvidence(
        {
          organizationId: ORG,
          kind: 'INVOICE',
          title: 'wrong tenant case',
          source: { type: 'FILE_ASSET', fileAssetId: FILE_ASSET },
          caseId: CASE,
        },
        deps,
      ),
    ).rejects.toThrow(/不属于该租户/);
    expect(created).toHaveLength(0);
    expect(sink.rows).toHaveLength(0);
  });

  it('rejects an empty title and an empty external url', async () => {
    const { deps } = fixture();

    await expect(
      promoteEvidence(
        {
          organizationId: ORG,
          kind: 'INVOICE',
          title: '   ',
          source: { type: 'FILE_ASSET', fileAssetId: FILE_ASSET },
        },
        deps,
      ),
    ).rejects.toThrow(/title/);

    await expect(
      promoteEvidence(
        {
          organizationId: ORG,
          kind: 'INVOICE',
          title: 'ok',
          source: { type: 'EXTERNAL', externalUrl: '  ' },
        },
        deps,
      ),
    ).rejects.toThrow(/externalUrl/);
  });
});
