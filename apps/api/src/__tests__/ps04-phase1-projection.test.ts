/**
 * CHANGE B（MSG-20261003-141）— Independent-site Phase 1 只读投影 真实 PostgreSQL 验收。
 * 断言：append-only + 幂等（同 resultDigest） + latest 由 computedAt/ID 推导 + UPDATE/DELETE 拒绝 +
 *       externalWritePerformed / autoSubmitAllowed 被 DB CHECK 强制为 false +
 *       state 端点读出 phase1（qualification / evidence / claim-ready）且 notPersisted 清空。
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createPrismaPs04Phase1ProjectionStore,
  ps04Phase1ResultDigest,
} from '../services/independent-site/ps04-phase1-projection-store';
import { getIndependentSiteRecoveryState } from '../services/independent-site/ps04-state-read';

const prisma = new PrismaClient();
const ORG = 'cc280000-0000-4000-8000-000000000001';
const NOW = new Date('2026-10-04T07:00:00.000Z');
const LATER = new Date('2026-10-04T08:00:00.000Z');
const D1 = '1'.repeat(64);

const store = () => createPrismaPs04Phase1ProjectionStore(prisma);

const projection = (overrides: Record<string, unknown> = {}) => ({
  organizationId: ORG,
  disputeReference: 'dp:1',
  policyId: 'ps04-policy-2026',
  policyVersion: '1.0.0',
  algorithmVersion: 'v1',
  qualificationStatus: 'QUALIFIED' as const,
  qualificationReasonCodes: ['OK'],
  evidenceReadinessStatus: 'READY' as const,
  evidenceSummary: { kinds: ['ORDER_RECORD', 'DELIVERY_PROOF'] },
  claimReadyStatus: 'READY' as const,
  packageId: 'pkg:1',
  packageDigest: D1,
  computedAt: NOW,
  ...overrides,
});

const seedHandoff = () =>
  prisma.$executeRawUnsafe(
    'INSERT INTO "IndependentSiteHandoffFact" ("id","organizationId","merchantRef","paymentAccountRef","disputeReference","packageId","packageDigest","channel","handoffReference","attestedByActorId","executionKey","contentDigest","observedAt") ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8::"Ps04HandoffChannel",$9,$10,$11,$12,$13::timestamp)',
    'h-1',
    ORG,
    'merchant:1',
    'pa:token:1',
    'dp:1',
    'pkg:1',
    D1,
    'MANUAL_PORTAL',
    'portal:1',
    'actor-1',
    'exec-1',
    D1,
    NOW.toISOString(),
  );

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "IndependentSitePhase1Projection", "IndependentSiteSettlementFact", "IndependentSiteResponseFact", "IndependentSiteHandoffFact", "AuditLog", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: 'PS04 P1 租户', slug: 'ps04-p1-org' } });
});

describe('CHANGE B — Independent-site Phase 1 只读投影（真实 PostgreSQL）', () => {
  it('幂等 append（同 resultDigest 不产生第二行）+ corrected 追加历史 + latest 推导', async () => {
    const first = await store().appendProjection(projection());
    const second = await store().appendProjection(projection());
    expect(first.status).toBe('APPENDED');
    expect(second.status).toBe('ALREADY_APPENDED');

    // computedAt 不参与事实身份（同内容 → 幂等去重），修正内容才产生新投影行
    const sameContentLater = await store().appendProjection(projection({ computedAt: LATER }));
    expect(sameContentLater.status).toBe('ALREADY_APPENDED');

    const corrected = await store().appendProjection(
      projection({ qualificationStatus: 'INDETERMINATE', qualificationReasonCodes: ['INCOMPLETE_DATA'], computedAt: LATER }),
    );
    expect(corrected.status).toBe('APPENDED');
    const rows = await store().listProjections({ organizationId: ORG, disputeReference: 'dp:1' });
    expect(rows).toHaveLength(2);

    const latest = await store().loadLatestProjection({ organizationId: ORG, disputeReference: 'dp:1' });
    expect(latest?.computedAt).toEqual(LATER);
    expect(latest?.qualificationStatus).toBe('INDETERMINATE');
    expect(ps04Phase1ResultDigest(projection())).toBe(ps04Phase1ResultDigest(projection()));
  });

  it('append-only：UPDATE / DELETE 拒绝；externalWritePerformed / autoSubmitAllowed 被 CHECK 强制为 false', async () => {
    const { projectionId } = await store().appendProjection(projection());
    await expect(
      prisma.$executeRawUnsafe('UPDATE "IndependentSitePhase1Projection" SET "qualificationStatus" = $1 WHERE "id" = $2', 'NOT_QUALIFIED', projectionId),
    ).rejects.toThrow(/APPEND_ONLY/);
    await expect(prisma.$executeRawUnsafe('DELETE FROM "IndependentSitePhase1Projection" WHERE "id" = $1', projectionId)).rejects.toThrow(/APPEND_ONLY/);

    await expect(
      prisma.$executeRawUnsafe(
        'INSERT INTO "IndependentSitePhase1Projection" ("id","organizationId","disputeReference","policyId","policyVersion","algorithmVersion","qualificationStatus","qualificationReasonCodes","evidenceReadinessStatus","evidenceSummary","claimReadyStatus","packageId","packageDigest","externalWritePerformed","autoSubmitAllowed","resultDigest","computedAt") ' +
          "VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11,$12,$13,true,false,$14,$15::timestamp)",
        'bad-1',
        ORG,
        'dp:1',
        'p',
        '1.0.0',
        'v1',
        'QUALIFIED',
        JSON.stringify(['OK']),
        'READY',
        JSON.stringify({}),
        'READY',
        null,
        null,
        'f'.repeat(64),
        NOW.toISOString(),
      ),
    ).rejects.toThrow();
  });

  it('state 端点读出 phase1（qualification / evidence / claim-ready）且 notPersisted 清空', async () => {
    await seedHandoff();
    await store().appendProjection(projection());
    const result = await getIndependentSiteRecoveryState({
      session: { organizationId: ORG, actorUserId: 'actor-1', role: 'OWNER' },
      deps: {
        async loadHandoff(organizationId, disputeReference) {
          const rows = await prisma.$queryRawUnsafe<{ id: string; disputeReference: string; paymentAccountRef: string; channel: string; handoffReference: string; executionKey: string; observedAt: Date }[]>(
            'SELECT "id","disputeReference","paymentAccountRef","channel","handoffReference","executionKey","observedAt" FROM "IndependentSiteHandoffFact" WHERE "organizationId" = $1 AND "disputeReference" = $2',
            organizationId,
            disputeReference,
          );
          const row = rows[0];
          return row ? { ...row, observedAt: row.observedAt.toISOString() } : null;
        },
        async loadLatestResponse() {
          return null;
        },
        async loadLatestSettlement() {
          return null;
        },
        loadLatestPhase1Projection: (organizationId, disputeReference) => store().loadLatestProjection({ organizationId, disputeReference }),
      },
      disputeReference: 'dp:1',
    });
    expect(result.status).toBe(200);
    expect(result.body.notPersisted).toEqual([]);
    const phase1 = result.body.phase1 as Record<string, never>;
    expect((phase1.qualification as Record<string, unknown>).status).toBe('QUALIFIED');
    expect((phase1.evidence as Record<string, unknown>).readinessStatus).toBe('READY');
    expect((phase1.claimReady as Record<string, unknown>).status).toBe('READY');
    expect(phase1.externalWritePerformed).toBe(false);
    expect(phase1.autoSubmitAllowed).toBe(false);
  });
});
