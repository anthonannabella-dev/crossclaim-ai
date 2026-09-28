/**
 * C-0011 — ClaimItem 服务（单元，无数据库）。
 * 覆盖：生命周期白名单（无 AUTO_SUBMITTED）、关闭原因、caseId 不变量、
 * platformRef 空值的幂等语义、权限裁剪与证据边界。
 */

import { type PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import {
  CLAIM_EVIDENCE_TYPES,
  CLAIM_ITEM_AUDIT,
  CLAIM_ITEM_CLOSED_REASONS,
  CLAIM_ITEM_STATUSES,
  CLAIM_PLATFORM_TYPES,
  CLAIM_RESPONSIBLE_PARTIES,
  CLAIM_STATES_REQUIRING_CASE,
  FINANCE_CLAIM_ITEM_FIELDS,
  canTransitionClaimItem,
  createClaimItem,
  getClaimItem,
  listClaimItemEvidence,
  linkEvidence,
  requiresCase,
  transitionClaimItem,
} from '../services/claim/claim-items';
import { ForbiddenError, WorkflowError } from '../services/workflow';

const NOW = new Date('2026-09-28T18:00:00Z');
const ORG = 'b4000000-0000-4000-8000-0000000000aa';
const ACTOR = 'b4000000-0000-4000-8000-0000000000bb';
const base = { organizationId: ORG, actorUserId: ACTOR, role: 'ADMIN' } as const;

describe('C-0011 — 生命周期与枚举', () => {
  it('状态集合里**没有** AUTO_SUBMITTED（本设计不提供自动提交路径）', () => {
    expect([...CLAIM_ITEM_STATUSES]).toEqual([
      'DISCOVERED',
      'VERIFIED',
      'REVIEW_REQUIRED',
      'READY_TO_APPEAL',
      'SUBMITTED_MANUAL',
      'RECOVERED',
      'CLOSED',
    ]);
    expect(CLAIM_ITEM_STATUSES as readonly string[]).not.toContain('AUTO_SUBMITTED');
  });

  it('迁移白名单：主链逐步可走，跳级与终态外迁一律拒绝', () => {
    expect(canTransitionClaimItem('DISCOVERED', 'VERIFIED')).toBe(true);
    expect(canTransitionClaimItem('VERIFIED', 'REVIEW_REQUIRED')).toBe(true);
    expect(canTransitionClaimItem('READY_TO_APPEAL', 'SUBMITTED_MANUAL')).toBe(true);
    expect(canTransitionClaimItem('SUBMITTED_MANUAL', 'RECOVERED')).toBe(true);
    expect(canTransitionClaimItem('DISCOVERED', 'SUBMITTED_MANUAL')).toBe(false);
    expect(canTransitionClaimItem('CLOSED', 'VERIFIED')).toBe(false);
    // 任意非终态都可以直接关闭（原因由 closedReason 表达）
    for (const status of CLAIM_ITEM_STATUSES.filter((s) => s !== 'CLOSED')) {
      expect(canTransitionClaimItem(status, 'CLOSED')).toBe(true);
    }
  });

  it('caseId 不变量：REVIEW_REQUIRED 起必须入案', () => {
    expect(CLAIM_STATES_REQUIRING_CASE).toEqual([
      'REVIEW_REQUIRED',
      'READY_TO_APPEAL',
      'SUBMITTED_MANUAL',
      'RECOVERED',
    ]);
    expect(requiresCase('VERIFIED')).toBe(false);
    expect(requiresCase('REVIEW_REQUIRED')).toBe(true);
  });

  it('枚举集合与架构方裁定一致', () => {
    expect([...CLAIM_ITEM_CLOSED_REASONS]).toEqual([
      'RECOVERED',
      'REJECTED',
      'NOT_WORTH_PURSUING',
      'CUSTOMER_DECLINED',
    ]);
    expect([...CLAIM_RESPONSIBLE_PARTIES]).toEqual([
      'CARRIER',
      'PLATFORM',
      'PLATFORM_WAREHOUSE',
      'SELLER',
      'BUYER',
      'THIRD_PARTY',
      'UNKNOWN',
    ]);
    expect([...CLAIM_EVIDENCE_TYPES]).toContain('PLATFORM_DECISION');
    expect([...CLAIM_EVIDENCE_TYPES]).toContain('CLAIM_RESPONSE');
    expect([...CLAIM_EVIDENCE_TYPES]).toContain('CONTRACT_TERM');
    expect([...CLAIM_PLATFORM_TYPES]).toEqual(['AMAZON', 'TIKTOK', 'WALMART', 'UNKNOWN']);
    expect(FINANCE_CLAIM_ITEM_FIELDS).toEqual(['status', 'recoverableAmount', 'settlementRef']);
  });
});

function fakePrisma(options: { existing?: boolean; status?: string } = {}) {
  const create = vi.fn(async (_args: { data: Record<string, unknown> }) => ({ id: 'claim-1' }));
  const auditCreate = vi.fn(async (_args: { data: Record<string, unknown> }) => ({ id: 'audit-1' }));
  const findFirst = vi.fn(async () => (options.existing ? { id: 'claim-existing' } : null));
  const tx = {
    claimItem: { create },
    auditLog: { create: auditCreate },
  };
  const prisma = {
    claimItem: { findFirst },
    claimItemEvidence: { findFirst: vi.fn(async () => null) },
    $transaction: vi.fn(async (fn) => fn(tx)),
  } as unknown as PrismaClient;
  return { prisma, create, auditCreate, findFirst };
}

describe('C-0011 — createClaimItem', () => {
  it('VIEWER / FINANCE 无 manageClaimItems → Forbidden', async () => {
    for (const role of ['VIEWER', 'FINANCE']) {
      const { prisma, create } = fakePrisma();
      await expect(
        createClaimItem(prisma, {
          ...base,
          role,
          platformType: 'AMAZON',
          claimType: 'FBA_LOSS',
          platformRef: 'adj-1',
          occurredAt: NOW,
          normalizerVersion: 'normalizer-1',
        }),
      ).rejects.toThrow(ForbiddenError);
      expect(create).not.toHaveBeenCalled();
    }
  });

  it('platformRef 存在且命中既有行 → 幂等返回，不再建第二条', async () => {
    const { prisma, create } = fakePrisma({ existing: true });
    const result = await createClaimItem(
      prisma,
      {
        ...base,
        platformType: 'AMAZON',
        claimType: 'FBA_LOSS',
        platformRef: 'adj-1',
        occurredAt: NOW,
        normalizerVersion: 'normalizer-1',
      },
      { now: () => NOW },
    );
    expect(result).toEqual({ id: 'claim-existing', created: false, idempotency: 'PLATFORM_REF' });
    expect(create).not.toHaveBeenCalled();
  });

  it('platformRef 为空 → 允许创建、标记 UNAVAILABLE，并写告警审计', async () => {
    const { prisma, create, auditCreate } = fakePrisma();
    const result = await createClaimItem(
      prisma,
      {
        ...base,
        platformType: 'WALMART',
        claimType: 'OTIF_PENALTY',
        occurredAt: NOW,
        normalizerVersion: 'normalizer-1',
      },
      { now: () => NOW },
    );
    expect(result).toEqual({ id: 'claim-1', created: true, idempotency: 'UNAVAILABLE' });
    expect(create).toHaveBeenCalledTimes(1);
    const actions = auditCreate.mock.calls.map((call) => call[0].data.action);
    expect(actions).toContain(CLAIM_ITEM_AUDIT.created);
    expect(actions).toContain(CLAIM_ITEM_AUDIT.createdWithoutRef);
  });

  it('未知平台类型 / 空 claimType → INVALID_INPUT', async () => {
    const { prisma } = fakePrisma();
    await expect(
      createClaimItem(prisma, {
        ...base,
        platformType: 'SHOPIFY' as never,
        claimType: 'X',
        occurredAt: NOW,
        normalizerVersion: 'n',
      }),
    ).rejects.toThrow(WorkflowError);
    await expect(
      createClaimItem(prisma, {
        ...base,
        platformType: 'AMAZON',
        claimType: '   ',
        occurredAt: NOW,
        normalizerVersion: 'n',
      }),
    ).rejects.toThrow(WorkflowError);
  });
});

function fakeTransitionPrisma(status: string, caseId: string | null = null, casCount = 1) {
  const auditCreate = vi.fn(async (_args: { data: Record<string, unknown> }) => ({ id: 'audit-1' }));
  const updateMany = vi.fn(async (_args: { where: Record<string, unknown> }) => ({ count: casCount }));
  const tx = { claimItem: { updateMany }, auditLog: { create: auditCreate } };
  const prisma = {
    claimItem: { findFirst: vi.fn(async () => ({ id: 'claim-1', status, caseId })) },
    $transaction: vi.fn(async (fn) => fn(tx)),
  } as unknown as PrismaClient;
  return { prisma, updateMany, auditCreate };
}

describe('C-0011 — transitionClaimItem', () => {
  it('CLOSED 缺原因 → REASON_REQUIRED；非白名单原因同样拒绝', async () => {
    const { prisma } = fakeTransitionPrisma('VERIFIED');
    await expect(
      transitionClaimItem(prisma, { ...base, claimItemId: 'claim-1', to: 'CLOSED' }),
    ).rejects.toThrow(WorkflowError);
    await expect(
      transitionClaimItem(prisma, {
        ...base,
        claimItemId: 'claim-1',
        to: 'CLOSED',
        closedReason: '追回成功',
      }),
    ).rejects.toThrow(WorkflowError);
  });

  it('REVIEW_REQUIRED 缺 caseId → CLAIM_ITEM_CASE_REQUIRED', async () => {
    const { prisma, updateMany } = fakeTransitionPrisma('VERIFIED');
    await expect(
      transitionClaimItem(prisma, { ...base, claimItemId: 'claim-1', to: 'REVIEW_REQUIRED' }),
    ).rejects.toMatchObject({ code: 'CLAIM_ITEM_CASE_REQUIRED' });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('合法迁移写审计（from/to/claimItemId/caseId 全在）', async () => {
    const { prisma, auditCreate } = fakeTransitionPrisma('VERIFIED');
    const result = await transitionClaimItem(
      prisma,
      { ...base, claimItemId: 'claim-1', to: 'REVIEW_REQUIRED', caseId: 'case-9' },
      { now: () => NOW },
    );
    expect(result).toMatchObject({ from: 'VERIFIED', to: 'REVIEW_REQUIRED', closedReason: null });
    const row = auditCreate.mock.calls[0][0].data;
    expect(row.action).toBe('claim.verified_to_review_required');
    expect(row.changes).toMatchObject({
      fromStatus: 'VERIFIED',
      toStatus: 'REVIEW_REQUIRED',
      claimItemId: 'claim-1',
      caseId: 'case-9',
    });
  });

  it('非法跳级 → ILLEGAL_TRANSITION', async () => {
    const { prisma } = fakeTransitionPrisma('DISCOVERED');
    await expect(
      transitionClaimItem(prisma, { ...base, claimItemId: 'claim-1', to: 'RECOVERED' }),
    ).rejects.toThrow(WorkflowError);
  });
});

describe('C-0011 — FINANCE 裁剪与证据边界', () => {
  const row = {
    id: 'claim-1',
    caseId: 'case-1',
    opportunityId: null,
    platformType: 'AMAZON',
    claimType: 'FBA_LOSS',
    platformRef: 'adj-1',
    occurredAt: NOW,
    amountExpected: null,
    amountActual: null,
    currency: 'USD',
    recoverableAmount: { toFixed: () => '120.0000' },
    responsibleParty: 'PLATFORM_WAREHOUSE',
    status: 'RECOVERED',
    closedReason: null,
    normalizerVersion: 'n1',
    ruleVersionId: null,
    evidenceLinks: [{ id: 'link-1' }],
    case: { settlements: [{ id: 'settle-1' }] },
  };

  function fakeViewPrisma() {
    return {
      claimItem: { findFirst: vi.fn(async () => row) },
    } as unknown as PrismaClient;
  }

  it('OWNER 看到完整字段；FINANCE 只看到白名单三个字段', async () => {
    const full = await getClaimItem(fakeViewPrisma(), { organizationId: ORG, role: 'OWNER' }, 'claim-1');
    expect(Object.keys(full).sort()).toEqual(
      [
        'amountActual',
        'amountExpected',
        'caseId',
        'claimType',
        'closedReason',
        'currency',
        'evidenceLinkCount',
        'id',
        'normalizerVersion',
        'occurredAt',
        'opportunityId',
        'platformRef',
        'platformType',
        'recoverableAmount',
        'responsibleParty',
        'ruleVersionId',
        'status',
      ].sort(),
    );

    const finance = await getClaimItem(fakeViewPrisma(), { organizationId: ORG, role: 'FINANCE' }, 'claim-1');
    expect(finance).toEqual({
      id: 'claim-1',
      status: 'RECOVERED',
      recoverableAmount: '120.0000',
      settlementRef: 'settle-1',
    });
    expect(Object.keys(finance)).not.toContain('platformRef');
    expect(Object.keys(finance)).not.toContain('evidenceLinkCount');
  });

  it('VIEWER 连汇总都不可读；FINANCE 不能读证据联结', async () => {
    await expect(
      getClaimItem(fakeViewPrisma(), { organizationId: ORG, role: 'VIEWER' }, 'claim-1'),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      listClaimItemEvidence(fakeViewPrisma(), { organizationId: ORG, role: 'FINANCE' }, 'claim-1'),
    ).rejects.toThrow(ForbiddenError);
  });

  it('FINANCE 不能写证据联结', async () => {
    const prisma = fakeViewPrisma();
    await expect(
      linkEvidence(prisma, {
        organizationId: ORG,
        actorUserId: ACTOR,
        role: 'FINANCE',
        claimItemId: 'claim-1',
        evidenceId: 'ev-1',
      }),
    ).rejects.toThrow(ForbiddenError);
  });
});
