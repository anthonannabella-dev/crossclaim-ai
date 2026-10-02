/** R46 S4 —— FeeCalculationAdjustment 真实 PostgreSQL 验收（MSG-20261002-59 §3/§4） */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hashPassword } from '../services/auth';
import { recordFeeAdjustment, type FeeAdjustmentDeps } from '../services/settlement/record-fee-adjustment';

const prisma = new PrismaClient();
const FAST = { N: 1024, r: 8, p: 1, keyLength: 64 };
const ALLOW = new Set<string>();
const uuid = (): string => randomUUID();

let ORG_A = '';
let ORG_B = '';
let actor = '';

const deps: FeeAdjustmentDeps = {
  prisma,
  verifyApproval: async (r) => ALLOW.has(r.approvalId),
  assertActiveMembership: async (organizationId, userId) => {
    const row = await prisma.membership.findFirst({ where: { organizationId, userId, isActive: true }, select: { id: true } });
    if (!row) throw new Error('NO_ACTIVE_MEMBERSHIP');
  },
};

async function seedOrg(suffix: string) {
  const id = uuid();
  await prisma.organization.create({ data: { id, name: 'R46 S4adj ' + suffix, slug: `r46-s4adj-${suffix}-${uuid().slice(0, 8)}` } });
  const user = await prisma.user.create({
    data: {
      email: `r46-s4adj-${suffix}-${uuid().slice(0, 8)}@example.com`,
      passwordHash: hashPassword('r46-s4adj-pass-123', FAST),
      displayName: 'OWNER',
      status: 'ACTIVE',
      emailVerified: true,
    },
  });
  await prisma.membership.create({ data: { organizationId: id, userId: user.id, role: 'OWNER', isActive: true } });
  return { organizationId: id, userId: user.id };
}

/** 造一条已存在的 FeeCalculation（历史计算事实） */
async function claimFor(organizationId: string): Promise<string> {
  return (
    await prisma.claimItem.create({
      data: {
        organizationId,
        platformType: 'AMAZON',
        claimType: 'FBA_REIMBURSEMENT',
        occurredAt: new Date('2026-08-01T00:00:00.000Z'),
        normalizerVersion: 'v1',
      },
      select: { id: true },
    })
  ).id;
}

async function seedFeeCalculation(organizationId: string, feeAmount = '150.0000') {
  const claimItemId = await claimFor(organizationId);
  const evidence = await prisma.evidenceArtifact.create({ data: { organizationId, kind: 'OTHER', title: 'e' }, select: { id: true } });
  const settlement = await prisma.settlement.create({
    data: {
      organizationId,
      status: 'RECEIVED',
      source: 'PLATFORM_CREDIT',
      amount: '1000.0000',
      currency: 'USD',
      receivedAt: new Date('2026-09-30T01:00:00.000Z'),
      evidenceId: evidence.id,
      confirmationStatus: 'CONFIRMED',
      reconciliationStatus: 'RECONCILED',
      linkageBasisKind: 'CLAIM_ITEM_DIRECT',
      claimItemId,
    },
    select: { id: true },
  });
  const fee = await prisma.feeCalculation.create({
    data: {
      organizationId,
      claimItemId,
      feeChainId: uuid(),
      basis: 'RECOVERED_AMOUNT_PCT',
      rate: '0.15',
      baseAmount: '1000.0000',
      feeAmount,
      currency: 'USD',
      computation: { algorithmVersion: 'settlement-fee/v1' },
      membershipDigest: 'a'.repeat(64),
      feeBasisVersion: 'v1',
      policyRef: 'policy-2026-01',
    },
    select: { id: true },
  });
  const adjustment = await prisma.settlementAdjustment.create({
    data: {
      organizationId,
      originalSettlementId: settlement.id,
      adjustmentKind: 'REVERSAL',
      amount: '1000.0000',
      currency: 'USD',
      occurredAt: new Date('2026-10-01T02:00:00.000Z'),
      externalIdentityKind: 'BANK_TRANSACTION',
      externalIdentityValueHash: (uuid() + uuid()).replace(/-/g, '').slice(0, 64),
      externalIdentityVersion: 'v1',
      evidenceReferences: [{ evidenceArtifactId: evidence.id, digest: 'c'.repeat(64), kind: 'BANK_STATEMENT' }],
      reasonCode: 'PROVIDER_CHARGEBACK',
      approvalId: uuid(),
    },
    select: { id: true },
  });
  return { feeCalculationId: fee.id, settlementAdjustmentId: adjustment.id, evidenceArtifactId: evidence.id };
}

function input(over: Record<string, unknown> = {}) {
  const approvalId = uuid();
  ALLOW.add(approvalId);
  return {
    organizationId: ORG_A,
    actorUserId: actor,
    approvalId,
    targetFeeCalculationId: '',
    adjustmentKind: 'REVERSAL' as const,
    amount: '150.0000',
    currency: 'USD',
    reasonCode: 'REVERSAL_APPLIED',
    ...over,
  };
}

beforeAll(async () => {
  const a = await seedOrg('a');
  ORG_A = a.organizationId;
  actor = a.userId;
  const b = await seedOrg('b');
  ORG_B = b.organizationId;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('R46 S4 FeeCalculationAdjustment（真实 PostgreSQL）', () => {
  it('reversal → 追加 FeeCalculationAdjustment，历史 FeeCalculation 完全不变；Invoice/Payment 仍 0', async () => {
    const { feeCalculationId, settlementAdjustmentId, evidenceArtifactId } = await seedFeeCalculation(ORG_A);
    const before = await prisma.feeCalculation.findFirstOrThrow({ where: { id: feeCalculationId } });
    const r = await recordFeeAdjustment(
      deps,
      input({ targetFeeCalculationId: feeCalculationId, triggerSettlementAdjustmentIds: [settlementAdjustmentId], evidenceReferences: [{ evidenceArtifactId }] }) as never,
    );
    expect(r.netFeeEffect).toBe('-150.0000');

    const after = await prisma.feeCalculation.findFirstOrThrow({ where: { id: feeCalculationId } });
    expect(String(after.feeAmount)).toBe(String(before.feeAmount));
    expect(after.membershipDigest).toBe(before.membershipDigest);
    expect(after.calculatedAt.getTime()).toBe(before.calculatedAt.getTime());

    expect(await prisma.billingInvoice.count({ where: { organizationId: ORG_A } })).toBe(0);
    expect(await prisma.payment.count({ where: { organizationId: ORG_A } })).toBe(0);
  });

  it('同一 reversal 再次生成 → ADJUSTMENT_REPLAYED（零新增）', async () => {
    const { feeCalculationId, settlementAdjustmentId, evidenceArtifactId } = await seedFeeCalculation(ORG_A);
    await recordFeeAdjustment(
      deps,
      input({ targetFeeCalculationId: feeCalculationId, triggerSettlementAdjustmentIds: [settlementAdjustmentId], evidenceReferences: [{ evidenceArtifactId }] }) as never,
    );
    const before = await prisma.feeCalculationAdjustment.count({ where: { organizationId: ORG_A } });
    await expect(
      recordFeeAdjustment(
        deps,
        input({ targetFeeCalculationId: feeCalculationId, triggerSettlementAdjustmentIds: [settlementAdjustmentId], evidenceReferences: [{ evidenceArtifactId }] }) as never,
      ),
    ).rejects.toMatchObject({ code: 'ADJUSTMENT_REPLAYED' });
    expect(await prisma.feeCalculationAdjustment.count({ where: { organizationId: ORG_A } })).toBe(before);
  });

  it('跨租户目标 / 触发源缺失 / approval 重复消费 → 拒绝且零写入', async () => {
    const local = await seedFeeCalculation(ORG_A);
    const { feeCalculationId: foreignId, settlementAdjustmentId: foreignAdjId } = await seedFeeCalculation(ORG_B);
    const before = await prisma.feeCalculationAdjustment.count({ where: { organizationId: ORG_A } });
    await expect(
      recordFeeAdjustment(
        deps,
        input({
          targetFeeCalculationId: uuid(),
          triggerSettlementAdjustmentIds: [local.settlementAdjustmentId],
          evidenceReferences: [{ evidenceArtifactId: local.evidenceArtifactId }],
        }) as never,
      ),
    ).rejects.toMatchObject({ code: 'FEE_CALCULATION_NOT_FOUND' });
    await expect(
      recordFeeAdjustment(
        deps,
        input({
          targetFeeCalculationId: foreignId,
          triggerSettlementAdjustmentIds: [foreignAdjId],
          evidenceReferences: [{ evidenceArtifactId: local.evidenceArtifactId }],
        }) as never,
      ),
    ).rejects.toMatchObject({ code: 'CROSS_TENANT_REFERENCE' });

    const { feeCalculationId, settlementAdjustmentId, evidenceArtifactId } = await seedFeeCalculation(ORG_A);
    const payload = input({ targetFeeCalculationId: feeCalculationId, triggerSettlementAdjustmentIds: [settlementAdjustmentId], evidenceReferences: [{ evidenceArtifactId }] });
    await recordFeeAdjustment(deps, payload as never);
    // 重放优先命中「同一 reversal 已产生 fee 调整」这一更强的领域错误（两者均 fail-closed、零新增）
    await expect(recordFeeAdjustment(deps, { ...payload } as never)).rejects.toMatchObject({
      code: 'ADJUSTMENT_REPLAYED',
    });
    expect(await prisma.feeCalculationAdjustment.count({ where: { organizationId: ORG_A } })).toBe(before + 1);
  });
});

describe('R46 S4 MSG-20261002-60A CHANGE ②/③：evidence provenance 与 adjustment approval 绑定点', () => {
  it('客户端自证 evidence digest/kind → CLIENT_EVIDENCE_NOT_TRUSTED；evidence 缺失 → EVIDENCE_NOT_FOUND；跨租户 evidence → CROSS_TENANT_REFERENCE（零写入）', async () => {
    const local = await seedFeeCalculation(ORG_A);
    const foreign = await seedFeeCalculation(ORG_B);
    const before = await prisma.feeCalculationAdjustment.count({ where: { organizationId: ORG_A } });
    const auditBefore = await prisma.auditLog.count({
      where: { organizationId: ORG_A, action: 'billing.fee_adjust.approval_consumed' },
    });

    await expect(
      recordFeeAdjustment(
        deps,
        input({
          targetFeeCalculationId: local.feeCalculationId,
          triggerSettlementAdjustmentIds: [local.settlementAdjustmentId],
          evidenceReferences: [{ evidenceArtifactId: local.evidenceArtifactId, digest: 'f'.repeat(64), kind: 'BANK_STATEMENT' }],
        }) as never,
      ),
    ).rejects.toMatchObject({ code: 'CLIENT_EVIDENCE_NOT_TRUSTED' });

    await expect(
      recordFeeAdjustment(
        deps,
        input({
          targetFeeCalculationId: local.feeCalculationId,
          triggerSettlementAdjustmentIds: [local.settlementAdjustmentId],
          evidenceReferences: [{ evidenceArtifactId: uuid() }],
        }) as never,
      ),
    ).rejects.toMatchObject({ code: 'EVIDENCE_NOT_FOUND' });

    await expect(
      recordFeeAdjustment(
        deps,
        input({
          targetFeeCalculationId: local.feeCalculationId,
          triggerSettlementAdjustmentIds: [local.settlementAdjustmentId],
          evidenceReferences: [{ evidenceArtifactId: foreign.evidenceArtifactId }],
        }) as never,
      ),
    ).rejects.toMatchObject({ code: 'CROSS_TENANT_REFERENCE' });

    expect(await prisma.feeCalculationAdjustment.count({ where: { organizationId: ORG_A } })).toBe(before);
    expect(
      await prisma.auditLog.count({ where: { organizationId: ORG_A, action: 'billing.fee_adjust.approval_consumed' } }),
    ).toBe(auditBefore);
  });

  it('reasonText / correctionDirection / evidenceReferences 审批后漂移 → 旧 approval 失效（APPROVAL_REQUIRED，零新增写入）；落库 provenance 为服务端派生', async () => {
    const bound = new Map<string, string>();
    const tofu: FeeAdjustmentDeps = {
      ...deps,
      verifyApproval: async (r) => {
        const digest = r.boundExtra.feeAdjustmentSnapshotDigest ?? '';
        const prior = bound.get(r.approvalId);
        if (prior === undefined) {
          bound.set(r.approvalId, digest);
          return true;
        }
        return prior === digest;
      },
    };
    const target = await seedFeeCalculation(ORG_A);
    const secondEvidence = await prisma.evidenceArtifact.create({
      data: { organizationId: ORG_A, kind: 'OTHER', title: 'second evidence' },
      select: { id: true },
    });
    const approvalId = uuid();
    const frozen = {
      organizationId: ORG_A,
      actorUserId: actor,
      approvalId,
      targetFeeCalculationId: target.feeCalculationId,
      adjustmentKind: 'REVERSAL' as const,
      amount: '150.0000',
      currency: 'USD',
      reasonCode: 'REVERSAL_APPLIED',
      reasonText: 'provider chargeback observed',
      correctionDirection: 'DECREASE' as const,
      triggerSettlementAdjustmentIds: [target.settlementAdjustmentId],
      evidenceReferences: [{ evidenceArtifactId: target.evidenceArtifactId }],
    };

    const first = await recordFeeAdjustment(tofu, frozen as never);
    expect(first.netFeeEffect).toBe('-150.0000');
    const afterFirst = await prisma.feeCalculationAdjustment.count({ where: { organizationId: ORG_A } });

    // 服务端派生 provenance（客户端从未提交 digest/kind）
    const stored = await prisma.feeCalculationAdjustment.findFirstOrThrow({
      where: { organizationId: ORG_A, targetFeeCalculationId: target.feeCalculationId },
      select: { evidenceReferences: true, reasonText: true },
    });
    const refs = stored.evidenceReferences as { evidenceArtifactId: string; digest: string; kind: string }[];
    expect(refs.length).toBe(1);
    expect(refs[0].evidenceArtifactId).toBe(target.evidenceArtifactId);
    expect(refs[0].digest).toMatch(/^[0-9a-f]{64}$/);
    expect(refs[0].kind).toBe('OTHER');
    expect(stored.reasonText).toBe('provider chargeback observed');

    for (const drift of [
      { reasonText: 'provider chargeback observed (edited)' },
      { correctionDirection: 'INCREASE' as const },
      { evidenceReferences: [{ evidenceArtifactId: secondEvidence.id }] },
      { reasonCode: 'REVERSAL_EDITED' },
    ]) {
      await expect(
        recordFeeAdjustment(tofu, { ...frozen, ...drift } as never),
      ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    }

    expect(await prisma.feeCalculationAdjustment.count({ where: { organizationId: ORG_A } })).toBe(afterFirst);
    expect(await prisma.billingInvoice.count({ where: { organizationId: ORG_A } })).toBe(0);
    expect(await prisma.payment.count({ where: { organizationId: ORG_A } })).toBe(0);
    expect(await prisma.recoveryLedgerEntry.count({ where: { organizationId: ORG_A } })).toBe(0);
  });
});
