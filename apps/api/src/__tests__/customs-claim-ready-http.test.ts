/**
 * G11 — Customs G4 只读 HTTP handler 回归（依赖注入的 fake store，不需要真实 DB）。
 */

import { describe, expect, it } from 'vitest';

import type { CustomsEntryFactStore, CustomsProjectionKind } from '../services/customs/customs-entry-fact-store';
import {
  getCustomsClaimReadyView,
  getCustomsEntryFactReadModel,
} from '../services/customs/customs-claim-ready-http';

const ORG = 'org-1';

function fakeStore(): CustomsEntryFactStore {
  const fact = {
    id: 'fact-1',
    organizationId: ORG,
    entryNumber: 'ABI-2026-000123',
    entryDate: '2026-09-18',
    jurisdiction: 'US',
    portOfEntry: 'Los Angeles, CA',
    importerOfRecordRef: 'ior_acct_88213',
    source: 'ABI_VENDOR',
    rawReference: 'abi:entry:88213',
    observedAt: '2026-09-19T02:11:00.000Z',
    totalDutyAmountByCurrency: { USD: '120.00' },
    contentDigest: 'a'.repeat(64),
    lines: [{ lineOrdinal: 0, kind: 'DUTY', rawCode: 'DUTY-9901', amount: '120.000000', currency: 'USD' }],
  };
  const projections: Record<string, Record<string, unknown>> = {
    DUTY_TRUTH: { id: 'p1', inputFactId: 'fact-1', inputDigest: 'a'.repeat(64), algorithmVersion: 'g11-v1', resultDigest: 'b'.repeat(64), computedAt: '2026-10-03T12:40:00.000Z', policyId: null, policyVersion: null, payload: { totalByCurrency: { USD: '120.00' } } },
    DISCREPANCY: { id: 'p2', inputFactId: 'fact-1', inputDigest: 'a'.repeat(64), algorithmVersion: 'g11-v1', resultDigest: 'c'.repeat(64), computedAt: '2026-10-03T12:40:00.000Z', policyId: null, policyVersion: null, payload: { itemCount: 1 } },
    ELIGIBILITY: { id: 'p3', inputFactId: 'fact-1', inputDigest: 'a'.repeat(64), algorithmVersion: 'g11-v1', resultDigest: 'd'.repeat(64), computedAt: '2026-10-03T12:40:00.000Z', policyId: 'customs-us-2026', policyVersion: '1.0.0', payload: { status: 'ELIGIBLE' } },
    ESTIMATE: { id: 'p4', inputFactId: 'fact-1', inputDigest: 'a'.repeat(64), algorithmVersion: 'g11-v1', resultDigest: 'e'.repeat(64), computedAt: '2026-10-03T12:40:00.000Z', policyId: 'customs-estimate-2026', policyVersion: '1.0.0', payload: { status: 'ESTIMATED', byCurrency: [{ currency: 'USD', estimatedAmount: '20.00' }] } },
  };
  return {
    async recordFact() {
      throw new Error('not used');
    },
    async loadFact({ organizationId, factId }) {
      return organizationId === ORG && factId === 'fact-1' ? fact : null;
    },
    async appendProjection() {
      throw new Error('not used');
    },
    async listProjections({ kind }: { organizationId: string; inputFactId: string; kind: CustomsProjectionKind }) {
      const row = projections[kind];
      return row ? [row as never] : [];
    },
    async loadLatestProjection({ kind }: { organizationId: string; inputFactId: string; kind: CustomsProjectionKind }) {
      return (projections[kind] ?? null) as never;
    },
  };
}

const session = (role: string) => ({ organizationId: ORG, actorUserId: 'u1', role });

describe('G11 — customs claim-ready read HTTP', () => {
  it('200：事实摘要 + 四类 latest 投影 + 只读边界声明', async () => {
    const result = await getCustomsEntryFactReadModel({
      session: session('OPS'),
      deps: { store: fakeStore() },
      entryFactId: 'fact-1',
    });
    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    expect((body.entryFact as Record<string, unknown>).entryNumber).toBe('ABI-2026-000123');
    const projections = body.projections as Record<string, unknown>;
    expect(Object.keys(projections).sort()).toEqual(['DISCREPANCY', 'DUTY_TRUTH', 'ELIGIBILITY', 'ESTIMATE']);
    expect((body.boundary as Record<string, unknown>).filingSubmitted).toBe(false);
    expect((body.boundary as Record<string, unknown>).transportEnabled).toBe(false);
    expect(JSON.stringify(body)).not.toContain('credential');
    expect(JSON.stringify(body)).not.toContain('rawPayload');
  });

  it('RBAC：VIEWER / 未知角色 → 403；FINANCE 可读', async () => {
    for (const role of ['VIEWER', 'UNKNOWN']) {
      const denied = await getCustomsEntryFactReadModel({ session: session(role), deps: { store: fakeStore() }, entryFactId: 'fact-1' });
      expect(denied.status).toBe(403);
    }
    const allowed = await getCustomsEntryFactReadModel({ session: session('FINANCE'), deps: { store: fakeStore() }, entryFactId: 'fact-1' });
    expect(allowed.status).toBe(200);
  });

  it('跨租户 / 不存在事实 → 404（不泄漏存在性）；空 id → 400', async () => {
    const other = await getCustomsEntryFactReadModel({
      session: { organizationId: 'org-2', actorUserId: 'u1', role: 'OWNER' },
      deps: { store: fakeStore() },
      entryFactId: 'fact-1',
    });
    expect(other.status).toBe(404);
    const missing = await getCustomsEntryFactReadModel({ session: session('OWNER'), deps: { store: fakeStore() }, entryFactId: 'nope' });
    expect(missing.status).toBe(404);
    const bad = await getCustomsEntryFactReadModel({ session: session('OWNER'), deps: { store: fakeStore() }, entryFactId: '  ' });
    expect(bad.status).toBe(400);
  });

  it('claim-ready 视图：estimateOnly/billable=false，且不承诺 filing', async () => {
    const result = await getCustomsClaimReadyView({ session: session('OWNER'), deps: { store: fakeStore() }, entryFactId: 'fact-1' });
    expect(result.status).toBe(200);
    const boundary = result.body.boundary as Record<string, unknown>;
    expect(boundary.estimateOnly).toBe(true);
    expect(boundary.billable).toBe(false);
    expect(boundary.filingSubmitted).toBe(false);
    expect(boundary.submissionPerformed).toBe(false);
    const estimate = result.body.estimate as Record<string, unknown>;
    expect((estimate.byCurrency as unknown[]).length).toBe(1);
  });
});
