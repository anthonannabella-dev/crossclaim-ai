/** P0-1 — 只读证据视图回归（消费已持久化结果，绝不重算）。 */

import { describe, expect, it } from 'vitest';

import { getReturnClaimEvidenceView } from '../services/customs/customs-return-claim-evidence';

const session = (role: string) => ({ organizationId: 'org-1', actorUserId: 'u1', role });

const row = {
  id: 'ev-1',
  status: 'READY',
  reasonCodes: [],
  confirmedRecoverableAmountByCurrency: { USD: '200.000000' },
  eligibleQuantityByLine: [{ lineOrdinal: 0, status: 'EXACT', eligibleQuantity: '10.000000', confirmedDutyAmount: '200.000000' }],
  qualificationStatus: 'QUALIFIED',
  policyId: 'customs-return-2026',
  policyVersion: '1.0.0',
  algorithmVersion: 'p0-1-e2e-v1',
  computedAt: new Date('2026-10-03T13:10:00.000Z'),
  payload: { boundary: { filingSubmitted: false } },
};

const deps = (value: Record<string, unknown> | null) => ({
  latest: async () => value,
});

describe('P0-1 — return claim evidence read view', () => {
  it('200：只返回已持久化结果 + 只读边界（不重算）', async () => {
    const result = await getReturnClaimEvidenceView({ session: session('OPS'), deps: deps(row), entryFactId: 'fact-1' });
    expect(result.status).toBe(200);
    const evidence = result.body.evidence as Record<string, unknown>;
    expect(evidence.status).toBe('READY');
    expect(evidence.confirmedRecoverableAmountByCurrency).toEqual({ USD: '200.000000' });
    const boundary = result.body.boundary as Record<string, unknown>;
    expect(boundary.recomputedOnRead).toBe(false);
    expect(boundary.frontendMayRecalculate).toBe(false);
    expect(boundary.filingSubmitted).toBe(false);
  });

  it('VIEWER → 403；无记录 → 404；空 id → 400', async () => {
    expect((await getReturnClaimEvidenceView({ session: session('VIEWER'), deps: deps(row), entryFactId: 'fact-1' })).status).toBe(403);
    expect((await getReturnClaimEvidenceView({ session: session('OWNER'), deps: deps(null), entryFactId: 'fact-1' })).status).toBe(404);
    expect((await getReturnClaimEvidenceView({ session: session('OWNER'), deps: deps(row), entryFactId: '  ' })).status).toBe(400);
  });

  it('跨租户：deps 查询按 session 租户执行 → 他租户看不到（返回 404）', async () => {
    const tenantScoped = {
      latest: async ({ organizationId }: { organizationId: string }) => (organizationId === 'org-1' ? row : null),
    };
    expect((await getReturnClaimEvidenceView({ session: session('OWNER'), deps: tenantScoped, entryFactId: 'fact-1' })).status).toBe(200);
    expect(
      (await getReturnClaimEvidenceView({
        session: { organizationId: 'org-2', actorUserId: 'u1', role: 'OWNER' },
        deps: tenantScoped,
        entryFactId: 'fact-1',
      })).status,
    ).toBe(404);
  });
});
