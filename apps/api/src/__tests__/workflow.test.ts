/**
 * C-0008-B1 — role permission matrix and opportunity review (unit, no database).
 * ---------------------------------------------------------------------------
 * The matrix below is copied from the approved C-0008-B kickoff ruling; if the
 * ruling changes, this table must change with it.
 */

import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import {
  APP_ROLES,
  ForbiddenError,
  PERMISSIONS,
  REJECT_REASONS,
  WorkflowError,
  assertPermission,
  permissionsFor,
  reviewOpportunity,
  type AppRole,
  type PermissionMatrix,
} from '../services/workflow';

type Row = [boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean];

const EXPECTED: Record<AppRole, Row> = {
  //            conn  review case  feeTerms claimText claimAmt billingView billingAdvance
  OWNER: [true, true, true, true, true, true, true, true],
  ADMIN: [true, true, true, true, true, true, true, true],
  OPS: [false, true, true, false, true, true, true, false],
  FINANCE: [false, false, false, false, false, false, true, true],
  VIEWER: [false, false, false, false, false, false, false, false],
};

const DENY_ALL: PermissionMatrix = {
  manageConnections: false,
  reviewOpportunities: false,
  createCase: false,
  setCommercialTerms: false,
  viewClaimText: false,
  viewClaimAmounts: false,
  viewBilling: false,
  advanceBilling: false,
  viewClaimItemSummary: false,
  viewClaimEvidence: false,
  manageClaimItems: false,
  claimTrackingApprove: false,
  claimTrackingReceive: false,
  recoveryPayoutRecord: false,
  recordCarrierManualSubmission: false,
  recordCarrierClaimResponse: false,
};

function asRow(role: AppRole): Row {
  const p = PERMISSIONS[role];
  return [
    p.manageConnections,
    p.reviewOpportunities,
    p.createCase,
    p.setCommercialTerms,
    p.viewClaimText,
    p.viewClaimAmounts,
    p.viewBilling,
    p.advanceBilling,
  ];
}

interface FakeTx {
  recoveryOpportunity: {
    updateMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
  auditLog: { create: ReturnType<typeof vi.fn> };
}

/**
 * `status` 是"数据库里现在是什么"；`casHits` 决定原子 CAS 是否命中
 * （命中 = 该行当时确实是 DETECTED）。
 */
function fakePrisma(status: string | null, casHits = status !== null) {
  const tx: FakeTx = {
    recoveryOpportunity: {
      updateMany: vi.fn(async () => ({ count: casHits ? 1 : 0 })),
      findFirst: vi.fn(async () => (status === null ? null : { status })),
    },
    auditLog: { create: vi.fn(async () => ({ id: 'audit-1' })) },
  };
  const transaction = vi.fn(async (fn: (client: FakeTx) => Promise<unknown>) => fn(tx));
  return { prisma: { $transaction: transaction } as unknown as PrismaClient, tx, transaction };
}

const NOW = new Date('2026-09-28T18:00:00Z');
const baseInput = {
  organizationId: 'f0000000-0000-4000-8000-00000000000a',
  opportunityId: '11111111-1111-4111-8111-111111111111',
  actorUserId: '22222222-2222-4222-8222-222222222222',
  role: 'OPS',
} as const;

describe('C-0008-B1 — 角色权限矩阵', () => {
  it('五角色权限与架构裁定表逐项一致', () => {
    expect([...APP_ROLES]).toEqual(['OWNER', 'ADMIN', 'OPS', 'FINANCE', 'VIEWER']);
    for (const role of APP_ROLES) expect(asRow(role)).toEqual(EXPECTED[role]);
    // FINANCE 看不见 Claim 正文；VIEWER 与 FINANCE 都不能复核机会。
    expect(PERMISSIONS.FINANCE.viewClaimText).toBe(false);
    expect(PERMISSIONS.FINANCE.reviewOpportunities).toBe(false);
    expect(PERMISSIONS.OPS.advanceBilling).toBe(false);
    expect(PERMISSIONS.OPS.viewBilling).toBe(true);
    // MSG-20260928-53 裁定 1：OPS 可建案但不可填写费率
    expect(PERMISSIONS.OPS.createCase).toBe(true);
    expect(PERMISSIONS.OPS.setCommercialTerms).toBe(false);
    expect(PERMISSIONS.ADMIN.setCommercialTerms).toBe(true);
  });

  it('未知 / 空角色 fail closed（全部拒绝）', () => {
    for (const role of ['SUPERUSER', 'owner', '', null, undefined]) {
      expect(permissionsFor(role)).toEqual(DENY_ALL);
    }
  });

  it('assertPermission 对越权抛出 ForbiddenError（code=FORBIDDEN）', () => {
    expect(() => assertPermission('VIEWER', 'viewBilling')).toThrow(ForbiddenError);
    expect(() => assertPermission('FINANCE', 'reviewOpportunities')).toThrow(ForbiddenError);
    try {
      assertPermission('OPS', 'manageConnections');
      throw new Error('expected throw');
    } catch (error) {
      expect((error as ForbiddenError).code).toBe('FORBIDDEN');
    }
    expect(() => assertPermission('OPS', 'reviewOpportunities')).not.toThrow();
  });
});

describe('C-0008-B1 — reviewOpportunity 输入校验与越权', () => {
  it('无权限角色在触库前即被拒绝', async () => {
    const { prisma, transaction } = fakePrisma('DETECTED');
    await expect(
      reviewOpportunity(prisma, { ...baseInput, role: 'FINANCE', decision: 'QUALIFY' }, () => NOW),
    ).rejects.toThrow(ForbiddenError);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('REJECT 缺 reason → REASON_REQUIRED；非法 reason → INVALID_REASON', async () => {
    const { prisma, transaction } = fakePrisma('DETECTED');
    for (const reason of [undefined, '', '   ']) {
      await expect(
        reviewOpportunity(prisma, { ...baseInput, decision: 'REJECT', reason }, () => NOW),
      ).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    }
    await expect(
      reviewOpportunity(prisma, { ...baseInput, decision: 'REJECT', reason: 'because' }, () => NOW),
    ).rejects.toMatchObject({ code: 'INVALID_REASON' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('批准的拒绝词表全部可用', () => {
    expect([...REJECT_REASONS]).toEqual([
      'wrong_amount',
      'duplicate',
      'not_recoverable',
      'other',
    ]);
  });
});

describe('C-0008-B1 — reviewOpportunity 状态迁移与审计', () => {
  it('DETECTED → QUALIFIED：写 qualifiedAt，审计含 actorUserId 且无 reason', async () => {
    const { prisma, tx } = fakePrisma('DETECTED');
    const result = await reviewOpportunity(
      prisma,
      { ...baseInput, decision: 'QUALIFY' },
      () => NOW,
    );

    expect(result).toEqual({
      opportunityId: baseInput.opportunityId,
      from: 'DETECTED',
      to: 'QUALIFIED',
      reason: null,
    });
    expect(tx.recoveryOpportunity.updateMany).toHaveBeenCalledWith({
      where: {
        id: baseInput.opportunityId,
        organizationId: baseInput.organizationId,
        status: 'DETECTED',
      },
      data: { status: 'QUALIFIED', qualifiedAt: NOW, rejectedReason: null },
    });
    const audit = tx.auditLog.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({
      actorType: 'USER',
      actorUserId: baseInput.actorUserId,
      action: 'opportunity.status_changed',
      entityType: 'RecoveryOpportunity',
      entityId: baseInput.opportunityId,
      changes: { from: 'DETECTED', to: 'QUALIFIED', decision: 'QUALIFY' },
      createdAt: NOW,
    });
    expect(audit.changes).not.toHaveProperty('reason');
  });

  it('DETECTED → REJECTED：拒绝原因同时进入记录与审计', async () => {
    const { prisma, tx } = fakePrisma('DETECTED');
    const result = await reviewOpportunity(
      prisma,
      { ...baseInput, decision: 'REJECT', reason: 'duplicate' },
      () => NOW,
    );

    expect(result.to).toBe('REJECTED');
    expect(result.reason).toBe('duplicate');
    expect(tx.recoveryOpportunity.updateMany).toHaveBeenCalledWith({
      where: {
        id: baseInput.opportunityId,
        organizationId: baseInput.organizationId,
        status: 'DETECTED',
      },
      data: { status: 'REJECTED', rejectedReason: 'duplicate' },
    });
    expect(tx.auditLog.create.mock.calls[0][0].data.changes).toEqual({
      from: 'DETECTED',
      to: 'REJECTED',
      decision: 'REJECT',
      reason: 'duplicate',
    });
  });

  it('非 DETECTED 状态 → ILLEGAL_TRANSITION，且零写入', async () => {
    for (const status of ['QUALIFIED', 'REJECTED', 'CONVERTED', 'EXPIRED']) {
      const { prisma, tx } = fakePrisma(status, false);
      await expect(
        reviewOpportunity(prisma, { ...baseInput, decision: 'QUALIFY' }, () => NOW),
      ).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
      expect(tx.recoveryOpportunity.updateMany).toHaveBeenCalled();
      expect(tx.auditLog.create).not.toHaveBeenCalled();
    }
  });

  it('机会不存在（或跨租户）→ NOT_FOUND，且零写入', async () => {
    const { prisma, tx } = fakePrisma(null, false);
    await expect(
      reviewOpportunity(prisma, { ...baseInput, decision: 'QUALIFY' }, () => NOW),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(tx.recoveryOpportunity.updateMany).toHaveBeenCalledWith({
      where: {
        id: baseInput.opportunityId,
        organizationId: baseInput.organizationId,
        status: 'DETECTED',
      },
      data: { status: 'QUALIFIED', qualifiedAt: NOW, rejectedReason: null },
    });
    expect(tx.recoveryOpportunity.findFirst).toHaveBeenCalledWith({
      where: { id: baseInput.opportunityId, organizationId: baseInput.organizationId },
      select: { status: true },
    });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('CAS 未命中时绝不写审计（并发竞争者视角）', async () => {
    const { prisma, tx } = fakePrisma('QUALIFIED', false);
    await expect(
      reviewOpportunity(prisma, { ...baseInput, decision: 'REJECT', reason: 'duplicate' }, () => NOW),
    ).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('WorkflowError 带稳定 code 与 name', () => {
    const error = new WorkflowError('NOT_FOUND', 'x');
    expect(error.code).toBe('NOT_FOUND');
    expect(error.name).toBe('WorkflowError');
  });
});
