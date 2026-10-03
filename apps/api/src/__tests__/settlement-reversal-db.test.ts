/** R46 S3 —— SettlementAdjustment / Full Reversal（真实 PostgreSQL；MSG-20261002-56 范围） */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hashPassword } from '../services/auth';
import {
  createReversalDeps,
  recordSettlementReversal,
  ReversalError,
  type ReversalDeps,
} from '../services/settlement/record-reversal';

const prisma = new PrismaClient();
const FAST = { N: 1024, r: 8, p: 1, keyLength: 64 };
const ALLOW = new Set<string>();
const uuid = (): string => randomUUID();
const hex64 = (): string => (randomUUID() + randomUUID()).replace(/-/g, '').slice(0, 64);
void ReversalError;

let ORG_A = '';
let ORG_B = '';
let actor = '';
let evidenceA = '';
let settlementA = '';
let settlementB = '';

const deps: ReversalDeps = {
  prisma,
  verifyApproval: async (r) => ALLOW.has(r.approvalId),
  assertActiveMembership: async (organizationId, userId) => {
    const row = await prisma.membership.findFirst({
      where: { organizationId, userId, isActive: true },
      select: { id: true },
    });
    if (!row) throw new Error('NO_ACTIVE_MEMBERSHIP');
  },
};

async function seedOrg(suffix: string) {
  const id = uuid();
  await prisma.organization.create({
    data: { id, name: 'R46 S3 ' + suffix, slug: `r46-s3-${suffix}-${uuid().slice(0, 8)}` },
  });
  const user = await prisma.user.create({
    data: {
      email: `r46-s3-${suffix}-${uuid().slice(0, 8)}@example.com`,
      passwordHash: hashPassword('r46-s3-pass-123', FAST),
      displayName: 'OWNER',
      status: 'ACTIVE',
      emailVerified: true,
    },
  });
  await prisma.membership.create({ data: { organizationId: id, userId: user.id, role: 'OWNER', isActive: true } });
  return { organizationId: id, userId: user.id };
}

async function seedSettlement(organizationId: string, amount = '100.0000') {
  const row = await prisma.settlement.create({
    data: {
      organizationId,
      status: 'RECEIVED',
      source: 'PLATFORM_CREDIT',
      amount,
      currency: 'USD',
      receivedAt: new Date('2026-09-30T01:00:00.000Z'),
      confirmationStatus: 'CONFIRMED',
      reconciliationStatus: 'NOT_STARTED',
      linkageBasisKind: 'CASE_LEVEL_ALLOCATION',
    },
    select: { id: true },
  });
  return row.id;
}

function input(overrides: Record<string, unknown> = {}) {
  const approvalId = uuid();
  ALLOW.add(approvalId);
  return {
    organizationId: ORG_A,
    actorUserId: actor,
    approvalId,
    originalSettlementId: settlementA,
    amount: '100.0000',
    currency: 'USD',
    occurredAt: '2026-10-01T02:00:00.000Z',
    externalIdentityKind: 'BANK_TRANSACTION' as const,
    externalIdentityValueHash: hex64(),
    externalIdentityVersion: 'v1',
    evidenceReferences: [{ evidenceArtifactId: evidenceA }],
    reasonCode: 'PROVIDER_CHARGEBACK',
    ...overrides,
  };
}

beforeAll(async () => {
  const a = await seedOrg('a');
  ORG_A = a.organizationId;
  actor = a.userId;
  const b = await seedOrg('b');
  ORG_B = b.organizationId;
  evidenceA = (
    await prisma.evidenceArtifact.create({
      data: { organizationId: ORG_A, kind: 'OTHER', title: 'reversal evidence A' },
      select: { id: true },
    })
  ).id;
  settlementA = await seedSettlement(ORG_A);
  settlementB = await seedSettlement(ORG_B);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('R46 S3 settlement reversal（真实 PostgreSQL）', () => {
  it('happy path：append-only 冲回事实；原 Settlement 完全不变；下游零副作用', async () => {
    const before = await prisma.settlement.findFirstOrThrow({ where: { id: settlementA } });
    const r = await recordSettlementReversal(deps, input() as never);
    expect(r.status).toBe('CREATED');

    const after = await prisma.settlement.findFirstOrThrow({ where: { id: settlementA } });
    expect(String(after.amount)).toBe(String(before.amount));
    expect(after.receiptSnapshotId).toBe(before.receiptSnapshotId);
    expect(after.reconciliationStatus).toBe(before.reconciliationStatus);

    const adj = await prisma.settlementAdjustment.findFirstOrThrow({ where: { id: r.adjustmentId } });
    expect(adj.adjustmentKind).toBe('REVERSAL');
    expect(String(adj.amount)).toBe('100');
    expect(adj.currency).toBe('USD');

    expect(await prisma.feeCalculation.count({ where: { organizationId: ORG_A } })).toBe(0);
    expect(await prisma.billingInvoice.count({ where: { organizationId: ORG_A } })).toBe(0);
    expect(await prisma.payment.count({ where: { organizationId: ORG_A } })).toBe(0);
    expect(await prisma.recoveryLedgerEntry.count({ where: { organizationId: ORG_A } })).toBe(0);
  });

  it('金额/币种不一致 → fail-closed 且零写入', async () => {
    const before = await prisma.settlementAdjustment.count({ where: { organizationId: ORG_A } });
    await expect(
      recordSettlementReversal(deps, input({ amount: '99.0000' }) as never),
    ).rejects.toMatchObject({ code: 'REVERSAL_AMOUNT_MISMATCH' });
    expect(await prisma.settlementAdjustment.count({ where: { organizationId: ORG_A } })).toBe(before);
  });

  it('第二个不同 reversal event → REVERSAL_ALREADY_APPLIED', async () => {
    await expect(
      recordSettlementReversal(deps, input({ originalSettlementId: settlementA }) as never),
    ).rejects.toMatchObject({ code: 'REVERSAL_ALREADY_APPLIED' });
  });

  it('跨租户引用 → 拒绝', async () => {
    await expect(
      recordSettlementReversal(deps, input({ originalSettlementId: settlementB }) as never),
    ).rejects.toMatchObject({ code: 'CROSS_TENANT_REFERENCE' });
  });

  it('approval 已消费 → 整体回滚，无第二条调整事实', async () => {
    const s2 = await seedSettlement(ORG_A);
    const payload = input({ originalSettlementId: s2 });
    await recordSettlementReversal(deps, payload as never);
    const before = await prisma.settlementAdjustment.count({ where: { organizationId: ORG_A } });
    const replay = { ...payload, reasonCode: 'RETRY' };
    await recordSettlementReversal(deps, replay as never);
    expect(await prisma.settlementAdjustment.count({ where: { organizationId: ORG_A } })).toBe(before);
  });

  it('并发：两个不同 reversal event 竞争同一 Settlement → 仅一个有效 full reversal', async () => {
    const s3 = await seedSettlement(ORG_A);
    const [r1, r2] = await Promise.allSettled([
      recordSettlementReversal(deps, input({ originalSettlementId: s3 }) as never),
      recordSettlementReversal(deps, input({ originalSettlementId: s3 }) as never),
    ]);
    const ok = [r1, r2].filter((r) => r.status === 'fulfilled');
    const rows = await prisma.settlementAdjustment.count({ where: { organizationId: ORG_A, originalSettlementId: s3 } });
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(rows).toBe(1);
  });

  it('生产装配：verifier 缺失/拒绝 → fail-closed', async () => {
    const deny = createReversalDeps(prisma, { verify: async () => ({ valid: false }) } as never);
    const s4 = await seedSettlement(ORG_A);
    await expect(
      recordSettlementReversal(deny, input({ originalSettlementId: s4 }) as never),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(await prisma.settlementAdjustment.count({ where: { organizationId: ORG_A, originalSettlementId: s4 } })).toBe(0);
  });
});

describe('R46 S3 MSG-57 CHANGE 2/3：evidence 自证与 approval exactly-once', () => {
  it('客户端自证 evidence digest/kind → 拒绝且零写入', async () => {
    const s5 = await seedSettlement(ORG_A);
    const before = await prisma.settlementAdjustment.count({ where: { organizationId: ORG_A } });
    await expect(
      recordSettlementReversal(deps, input({
        originalSettlementId: s5,
        evidenceReferences: [{ evidenceArtifactId: evidenceA, digest: hex64(), kind: 'BANK_STATEMENT' }],
      }) as never),
    ).rejects.toMatchObject({ code: 'CLIENT_EVIDENCE_NOT_TRUSTED' });
    expect(await prisma.settlementAdjustment.count({ where: { organizationId: ORG_A } })).toBe(before);
  });

  it('same approvalId + 两个不同有效 execution → 恰好一次消费（loser APPROVAL_ALREADY_CONSUMED，零残留）', async () => {
    const a = await seedSettlement(ORG_A);
    const b = await seedSettlement(ORG_A);
    const approvalId = uuid();
    ALLOW.add(approvalId);
    const before = await prisma.settlementAdjustment.count({ where: { organizationId: ORG_A } });
    const results = await Promise.allSettled([
      recordSettlementReversal(deps, input({ originalSettlementId: a, approvalId }) as never),
      recordSettlementReversal(deps, input({ originalSettlementId: b, approvalId }) as never),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok.length).toBe(1);
    for (const f of failed) {
      expect((f.reason as { code?: string })?.code).toBe('APPROVAL_ALREADY_CONSUMED');
    }
    expect(await prisma.settlementAdjustment.count({ where: { organizationId: ORG_A } })).toBe(before + 1);
    const consumed = await prisma.auditLog.count({
      where: { id: 'settlement-reversal-approval-' + approvalId },
    });
    expect(consumed).toBe(1);
  });
});

describe('R46 S3 MSG-58 CHANGE A：approval 漂移（锁定 full reversal 事实）', () => {
  const capturing = () => {
    const seen: { digest?: string } = {};
    return {
      seen,
      deps: {
        prisma,
        assertActiveMembership: deps.assertActiveMembership,
        verifyApproval: async (request: { boundExtra: Record<string, string | null> }) => {
          seen.digest = request.boundExtra.reversalSnapshotDigest ?? undefined;
          return true;
        },
      } as never,
    };
  };

  const strict = (locked: { digest?: string }) =>
    ({
      prisma,
      assertActiveMembership: deps.assertActiveMembership,
      verifyApproval: async (request: { boundExtra: Record<string, string | null> }) =>
        Boolean(locked.digest) && request.boundExtra.reversalSnapshotDigest === locked.digest,
    }) as never;

  it('identity / occurredAt / evidence / reasonCode 任一在审批后变化 → 旧 approval 失效且零写入', async () => {
    const cases: Record<string, unknown>[] = [
      { externalIdentityValueHash: hex64() },
      { occurredAt: '2026-10-01T03:00:00.000Z' },
      { evidenceReferences: undefined },
      { reasonCode: 'DIFFERENT_REASON' },
    ];
    for (const variant of cases) {
      const s = await seedSettlement(ORG_A);
      const base = input({ originalSettlementId: s });
      const cap = capturing();
      await recordSettlementReversal(cap.deps, base as never);
      const locked = cap.seen;

      const s2 = await seedSettlement(ORG_A);
      const before = await prisma.settlementAdjustment.count({ where: { organizationId: ORG_A } });
      const drifted = variant.evidenceReferences === undefined
        ? { ...input({ originalSettlementId: s2 }), evidenceReferences: [{ evidenceArtifactId: uuid() }] }
        : { ...input({ originalSettlementId: s2 }), ...variant };
      await expect(recordSettlementReversal(strict(locked), drifted as never)).rejects.toMatchObject({
        code: 'APPROVAL_REQUIRED',
      });
      expect(await prisma.settlementAdjustment.count({ where: { organizationId: ORG_A } })).toBe(before);
    }
  });
});
