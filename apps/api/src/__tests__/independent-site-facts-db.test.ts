/**
 * BG-021 — INDEPENDENT-SITE / CHARGEBACK 事实层 **真实 PostgreSQL 验收**（MSG-20261003-139 APPROVED WITH REVISE）。
 * 覆盖：handoff root exactly-one（并发）/ executionKey 幂等 / same-dispute-different-key CONFLICT /
 * 同租户 lineage（response / settlement）/ cross-tenant 拒绝 / UPDATE·DELETE 拒绝 /
 * raw PAN-like·numeric account·free-text secret 拒绝 / invalid currency 拒绝 /
 * response source 白名单 / VERIFIED settlement 必须有 evidence / VERIFIED amount=0 拒绝 /
 * corrected 事实追加历史且 latest 可推导。
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const prisma = new PrismaClient();
const ORG = 'cc250000-0000-4000-8000-000000000001';
const ORG_B = 'cc250000-0000-4000-8000-000000000002';
const D1 = '1'.repeat(64);
const D2 = '2'.repeat(64);
const D3 = '3'.repeat(64);
const NOW = '2026-10-04T03:00:00.000Z';
const LATER = '2026-10-04T04:00:00.000Z';

const handoff = (opts: { id: string; organizationId?: string; dispute?: string; executionKey?: string; digest?: string; accountRef?: string; observedAt?: string }) =>
  prisma.$executeRawUnsafe(
    'INSERT INTO "IndependentSiteHandoffFact" ("id","organizationId","merchantRef","paymentAccountRef","disputeReference","packageId","packageDigest","channel","handoffReference","attestedByActorId","executionKey","contentDigest","observedAt") ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8::"Ps04HandoffChannel",$9,$10,$11,$12,$13::timestamp)',
    opts.id,
    opts.organizationId ?? ORG,
    'merchant:1',
    opts.accountRef ?? 'pa:token:1',
    opts.dispute ?? 'dp:1',
    'pkg:1',
    D1,
    'MANUAL_PORTAL',
    'portal:1',
    'actor-1',
    opts.executionKey ?? 'exec-1',
    opts.digest ?? D1,
    opts.observedAt ?? NOW,
  );

const response = (opts: { id: string; organizationId?: string; dispute?: string; disposition?: string; amount?: string | null; currency?: string; source?: string; digest?: string; observedAt?: string }) =>
  prisma.$executeRawUnsafe(
    'INSERT INTO "IndependentSiteResponseFact" ("id","organizationId","disputeReference","disposition","amount","currency","source","contentDigest","observedAt") ' +
      'VALUES ($1,$2,$3,$4::"Ps04ResponseDisposition",$5::numeric,$6,$7,$8,$9::timestamp)',
    opts.id,
    opts.organizationId ?? ORG,
    opts.dispute ?? 'dp:1',
    opts.disposition ?? 'WON',
    opts.amount === undefined ? '250.00' : opts.amount,
    opts.currency ?? 'USD',
    opts.source ?? 'FIXTURE',
    opts.digest ?? D2,
    opts.observedAt ?? NOW,
  );

const settlement = (opts: { id: string; organizationId?: string; dispute?: string; amount?: string; currency?: string; verification?: string; reference?: string; evidence?: string | null; digest?: string; receivedAt?: string }) =>
  prisma.$executeRawUnsafe(
    'INSERT INTO "IndependentSiteSettlementFact" ("id","organizationId","disputeReference","amount","currency","verification","reference","evidenceArtifactRef","contentDigest","receivedAt") ' +
      'VALUES ($1,$2,$3,$4::numeric,$5,$6::"Ps04SettlementVerification",$7,$8,$9,$10::timestamp)',
    opts.id,
    opts.organizationId ?? ORG,
    opts.dispute ?? 'dp:1',
    opts.amount ?? '100.00',
    opts.currency ?? 'USD',
    opts.verification ?? 'VERIFIED',
    opts.reference ?? 'stl:1',
    opts.evidence === undefined ? 'evid:1' : opts.evidence,
    opts.digest ?? D3,
    opts.receivedAt ?? NOW,
  );

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
  await prisma.organization.create({ data: { id: ORG, name: 'PS04 租户', slug: 'ps04-org' } });
  await prisma.organization.create({ data: { id: ORG_B, name: 'PS04 租户B', slug: 'ps04-org-b' } });
});

describe('BG-021 — Independent-site 事实层（真实 PostgreSQL）', () => {
  it('并发不同 executionKey 启动同一 dispute → exactly one root；同 executionKey 重放 → 唯一约束拒绝', async () => {
    const settled = await Promise.allSettled([
      handoff({ id: 'h-a', executionKey: 'exec-a' }),
      handoff({ id: 'h-b', executionKey: 'exec-b' }),
      handoff({ id: 'h-c', executionKey: 'exec-c' }),
    ]);
    expect(settled.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((item) => item.status === 'rejected')).toHaveLength(2);

    const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>('SELECT count(*)::bigint AS n FROM "IndependentSiteHandoffFact" WHERE "organizationId" = $1', ORG);
    expect(rows[0].n).toBe(1n);

    await expect(handoff({ id: 'h-replay', executionKey: 'exec-a', digest: D2 })).rejects.toThrow();
  });

  it('同 dispute 不同 executionKey（后续二次提交）→ 唯一约束拒绝（root 语义写死为 initial handoff root）', async () => {
    await handoff({ id: 'h-1', executionKey: 'exec-1' });
    await expect(handoff({ id: 'h-2', executionKey: 'exec-2', digest: D2 })).rejects.toThrow();
  });

  it('同租户 lineage：response / settlement 必须引用同租户 handoff root；跨租户一律拒绝', async () => {
    await expect(response({ id: 'r-orphan' })).rejects.toThrow(/LINEAGE_TENANT/);
    await expect(settlement({ id: 's-orphan' })).rejects.toThrow(/LINEAGE_TENANT/);

    await handoff({ id: 'h-a', organizationId: ORG });
    await expect(response({ id: 'r-cross', organizationId: ORG_B })).rejects.toThrow(/LINEAGE_TENANT/);
    await expect(settlement({ id: 's-cross', organizationId: ORG_B })).rejects.toThrow(/LINEAGE_TENANT/);

    await response({ id: 'r-ok' });
    await settlement({ id: 's-ok' });
  });

  it('append-only：UPDATE / DELETE 一律拒绝', async () => {
    await handoff({ id: 'h-1' });
    await expect(prisma.$executeRawUnsafe('UPDATE "IndependentSiteHandoffFact" SET "merchantRef" = $1 WHERE "id" = $2', 'merchant:2', 'h-1')).rejects.toThrow(/APPEND_ONLY/);
    await expect(prisma.$executeRawUnsafe('DELETE FROM "IndependentSiteHandoffFact" WHERE "id" = $1', 'h-1')).rejects.toThrow(/APPEND_ONLY/);
  });

  it('凭据防线：PAN-like / numeric account / 自由文本 secret → DB CHECK 拒绝', async () => {
    await expect(handoff({ id: 'h-pan', accountRef: '4242424242424242' })).rejects.toThrow();
    await expect(handoff({ id: 'h-num', accountRef: '123456789' })).rejects.toThrow();
    await expect(handoff({ id: 'h-text', accountRef: 'Bearer sk_live_abc123' })).rejects.toThrow();
  });

  it('response：source 白名单 / currency 形状 / 负金额 拒绝', async () => {
    await handoff({ id: 'h-1' });
    await expect(response({ id: 'r-source', source: 'PSP_WEBHOOK' })).rejects.toThrow();
    await expect(response({ id: 'r-currency', currency: 'usd' })).rejects.toThrow();
    await expect(response({ id: 'r-negative', amount: '-1.00' })).rejects.toThrow();
    await response({ id: 'r-null-amount', amount: null, disposition: 'LOST' });
  });

  it('settlement：VERIFIED 必须带 evidence；amount 必须 > 0；currency 形状；UNVERIFIED 可落库但不构成 recovered', async () => {
    await handoff({ id: 'h-1' });
    await expect(settlement({ id: 's-no-evidence', evidence: null })).rejects.toThrow();
    await expect(settlement({ id: 's-zero', amount: '0.00' })).rejects.toThrow();
    await expect(settlement({ id: 's-currency', currency: 'US' })).rejects.toThrow();
    await settlement({ id: 's-unverified', verification: 'UNVERIFIED', evidence: null });
    const rows = await prisma.$queryRawUnsafe<{ verification: string; amount: string }[]>(
      'SELECT "verification","amount"::text AS amount FROM "IndependentSiteSettlementFact" WHERE "id" = $1',
      's-unverified',
    );
    expect(rows[0].verification).toBe('UNVERIFIED');
  });

  it('corrected 事实追加历史：同一 dispute 可追加多条 response / settlement，latest 由 observedAt DESC, id DESC 推导', async () => {
    await handoff({ id: 'h-1' });
    await response({ id: 'r-old', disposition: 'PARTIAL', digest: D2, observedAt: NOW });
    await response({ id: 'r-new', disposition: 'WON', digest: D3, observedAt: LATER });
    const latest = await prisma.$queryRawUnsafe<{ id: string }[]>(
      'SELECT "id" FROM "IndependentSiteResponseFact" WHERE "organizationId" = $1 AND "disputeReference" = $2 ORDER BY "observedAt" DESC, "id" DESC',
      ORG,
      'dp:1',
    );
    expect(latest).toHaveLength(2);
    expect(latest[0].id).toBe('r-new');
  });
});
