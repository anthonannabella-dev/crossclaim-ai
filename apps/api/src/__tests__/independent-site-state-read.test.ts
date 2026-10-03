/**
 * BG-019（CHANGE E）— Independent-site 关键状态只读面 **真实 PostgreSQL 验收**。
 * 断言五个状态严格分离：WON 不等于到账、UNVERIFIED 不等于 recovered、只有 VERIFIED+evidence 才 billable；
 * 并断言与 chargeback-recovery-flow 的收敛语义一致（同源），以及 RBAC / 跨租户 / 只读边界。
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { consolidateIndependentSiteRecovery, type Ps04FeePolicyRef } from '../services/independent-site/chargeback-recovery-flow';
import { getIndependentSiteRecoveryState, type Ps04StateReadDeps } from '../services/independent-site/ps04-state-read';

const prisma = new PrismaClient();
const ORG = 'cc260000-0000-4000-8000-000000000001';
const ORG_B = 'cc260000-0000-4000-8000-000000000002';
const D1 = '1'.repeat(64);
const D2 = '2'.repeat(64);
const D3 = '3'.repeat(64);
const NOW = '2026-10-04T05:00:00.000Z';
const FEE_POLICY: Ps04FeePolicyRef = { policyId: 'success-fee-2026', policyVersion: '1.0.0', rateBasisPoints: 1500 };

const deps: Ps04StateReadDeps = {
  async loadHandoff(organizationId, disputeReference) {
    const rows = await prisma.$queryRawUnsafe<{ id: string; disputeReference: string; paymentAccountRef: string; channel: string; handoffReference: string; executionKey: string; observedAt: Date }[]>(
      'SELECT "id","disputeReference","paymentAccountRef","channel","handoffReference","executionKey","observedAt" FROM "IndependentSiteHandoffFact" WHERE "organizationId" = $1 AND "disputeReference" = $2',
      organizationId,
      disputeReference,
    );
    const row = rows[0];
    return row ? { ...row, observedAt: row.observedAt.toISOString() } : null;
  },
  async loadLatestResponse(organizationId, disputeReference) {
    const rows = await prisma.$queryRawUnsafe<{ id: string; disputeReference: string; disposition: string; amount: string | null; currency: string; source: string; observedAt: Date }[]>(
      'SELECT "id","disputeReference","disposition","amount"::text AS amount,"currency","source","observedAt" FROM "IndependentSiteResponseFact" WHERE "organizationId" = $1 AND "disputeReference" = $2 ORDER BY "observedAt" DESC, "id" DESC LIMIT 1',
      organizationId,
      disputeReference,
    );
    const row = rows[0];
    return row ? { ...row, observedAt: row.observedAt.toISOString() } : null;
  },
  async loadLatestSettlement(organizationId, disputeReference) {
    const rows = await prisma.$queryRawUnsafe<{ id: string; disputeReference: string; amount: string; currency: string; verification: string; reference: string; evidenceArtifactRef: string | null; receivedAt: Date }[]>(
      'SELECT "id","disputeReference","amount"::text AS amount,"currency","verification","reference","evidenceArtifactRef","receivedAt" FROM "IndependentSiteSettlementFact" WHERE "organizationId" = $1 AND "disputeReference" = $2 ORDER BY "receivedAt" DESC, "id" DESC LIMIT 1',
      organizationId,
      disputeReference,
    );
    const row = rows[0];
    return row ? { ...row, receivedAt: row.receivedAt.toISOString() } : null;
  },
};

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
    NOW,
  );

const seedResponse = (disposition: string, digest = D2) =>
  prisma.$executeRawUnsafe(
    'INSERT INTO "IndependentSiteResponseFact" ("id","organizationId","disputeReference","disposition","amount","currency","source","contentDigest","observedAt") VALUES ($1,$2,$3,$4::"Ps04ResponseDisposition",$5::numeric,$6,$7,$8,$9::timestamp)',
    'r-' + disposition,
    ORG,
    'dp:1',
    disposition,
    '250.00',
    'USD',
    'FIXTURE',
    digest,
    NOW,
  );

const seedSettlement = (verification: string, amount = '100.00', evidence: string | null = 'evid:1', digest = D3) =>
  prisma.$executeRawUnsafe(
    'INSERT INTO "IndependentSiteSettlementFact" ("id","organizationId","disputeReference","amount","currency","verification","reference","evidenceArtifactRef","contentDigest","receivedAt") VALUES ($1,$2,$3,$4::numeric,$5,$6::"Ps04SettlementVerification",$7,$8,$9,$10::timestamp)',
    's-' + verification,
    ORG,
    'dp:1',
    amount,
    'USD',
    verification,
    'stl:1',
    evidence,
    digest,
    NOW,
  );

const call = (role = 'OWNER', organizationId = ORG, disputeReference = 'dp:1') =>
  getIndependentSiteRecoveryState({ session: { organizationId, actorUserId: 'actor-1', role }, deps, disputeReference, feePolicy: FEE_POLICY });

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "IndependentSiteSettlementFact", "IndependentSiteResponseFact", "IndependentSiteHandoffFact", "AuditLog", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: 'PS04 读租户', slug: 'ps04-read-org' } });
  await prisma.organization.create({ data: { id: ORG_B, name: 'PS04 读租户B', slug: 'ps04-read-org-b' } });
});

describe('BG-019 — Independent-site 关键状态只读面（真实 PostgreSQL）', () => {
  it('仅 handoff → submitted=true，其余四个状态全 false；无 recovered/fee/invoice', async () => {
    await seedHandoff();
    const result = await call();
    expect(result.status).toBe(200);
    const states = result.body.states as Record<string, boolean>;
    expect(states).toEqual({ submitted: true, won: false, settled: false, recovered: false, billable: false });
    expect((result.body.amounts as Record<string, string>).recoveredAmount).toBe('0.000000');
    expect(result.body.invoiceDraft).toBeNull();
    expect((result.body.boundary as Record<string, unknown>).recomputedOnRead).toBe(false);
  });

  it('WON 响应不得被当作到账：won=true 但 settled/recovered/billable 仍 false', async () => {
    await seedHandoff();
    await seedResponse('WON');
    const states = (await call()).body.states as Record<string, boolean>;
    expect(states).toEqual({ submitted: true, won: true, settled: false, recovered: false, billable: false });
  });

  it('UNVERIFIED settlement 不是 recovered：settled/recovered/billable 全 false', async () => {
    await seedHandoff();
    await seedResponse('WON');
    await seedSettlement('UNVERIFIED', '100.00', null);
    const result = await call();
    const states = result.body.states as Record<string, boolean>;
    expect(states).toEqual({ submitted: true, won: true, settled: false, recovered: false, billable: false });
    expect((result.body.amounts as Record<string, string>).recoveredAmount).toBe('0.000000');
    expect(result.body.invoiceDraft).toBeNull();
  });

  it('VERIFIED + evidence + amount>0 且已 WON → 五状态同时为 true，15% 费用与发票草稿成立', async () => {
    await seedHandoff();
    await seedResponse('WON');
    await seedSettlement('VERIFIED');
    const result = await call();
    const states = result.body.states as Record<string, boolean>;
    expect(states).toEqual({ submitted: true, won: true, settled: true, recovered: true, billable: true });
    expect((result.body.amounts as Record<string, string>).recoveredAmount).toBe('100.000000');
    expect((result.body.amounts as Record<string, string>).feeAmount).toBe('15.000000');
    expect(result.body.invoiceDraft).toEqual({ amount: '15.000000', currency: 'USD', basis: 'VERIFIED_ACTUAL_INCREMENTAL_RECOVERY' });
  });

  it('与 chargeback-recovery-flow 收敛语义一致（同源判定，不产生第二套规则）', async () => {
    await seedHandoff();
    await seedResponse('WON');
    await seedSettlement('VERIFIED');
    const readStates = (await call()).body.states as Record<string, boolean>;
    const consolidation = consolidateIndependentSiteRecovery({
      organizationId: ORG,
      disputeReference: 'dp:1',
      currency: 'USD',
      disputeAmount: '250.00',
      handoff: {
        organizationId: ORG,
        disputeReference: 'dp:1',
        packageId: 'pkg:1',
        packageDigest: D1,
        channel: 'MANUAL_PORTAL',
        handoffReference: 'portal:1',
        attestedByActorId: 'actor-1',
        executionKey: 'exec-1',
        recordedAt: NOW,
      },
      response: { organizationId: ORG, disputeReference: 'dp:1', disposition: 'WON', amount: '250.00', currency: 'USD', source: 'FIXTURE', observedAt: NOW },
      settlement: { organizationId: ORG, disputeReference: 'dp:1', amount: '100.00', currency: 'USD', verification: 'VERIFIED', reference: 'stl:1', receivedAt: NOW },
      feePolicy: FEE_POLICY,
      expectedPackageDigest: D1,
      now: NOW,
    });
    expect(readStates).toEqual({
      submitted: consolidation.submitted,
      won: consolidation.won,
      settled: consolidation.settled,
      recovered: consolidation.recovered,
      billable: consolidation.billable,
    });
  });

  it('RBAC / 参数 / 租户：VIEWER 403；空 ID 400；无 handoff 404；跨租户 404（不泄漏存在性）', async () => {
    await seedHandoff();
    expect((await call('VIEWER')).status).toBe(403);
    expect((await call('OWNER', ORG, '   ')).status).toBe(400);
    expect((await call('OWNER', ORG, 'dp-unknown')).status).toBe(404);
    expect((await call('OWNER', ORG_B)).status).toBe(404);
    expect((await call('FINANCE')).status).toBe(200);
  });
});
