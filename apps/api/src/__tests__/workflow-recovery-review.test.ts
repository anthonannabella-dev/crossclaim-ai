/**
 * C-0009.2 Step 2 — high-value recovery gate (unit, no database).
 * ---------------------------------------------------------------
 * Threshold/currency rules, the audit-derived state machine with its ordering
 * invariant, the role matrix (FINANCE read-only) and the money gate itself.
 */

import { Prisma, type PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_HIGH_VALUE_THRESHOLD,
  ForbiddenError,
  REVIEW_ACTIONS,
  assertHighValueReviewCleared,
  requiresHighValueReview,
  resolveHighValueReviewState,
  resolveHighValueThreshold,
  submitRecoveryReview,
} from '../services/workflow';

const ORG = 'f0000000-0000-4000-8000-000000000014';
const ACTOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CASE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const NOW = new Date('2026-09-28T18:00:00Z');

const at = (iso: string) => new Date(iso);

describe('C-0009.2 — 阈值与币种规则', () => {
  it('默认阈值 1000.0000，可用环境变量覆盖，非法值回退默认', () => {
    expect(resolveHighValueThreshold({})).toBe(DEFAULT_HIGH_VALUE_THRESHOLD);
    expect(resolveHighValueThreshold({ HITL_RECOVERY_THRESHOLD: '2500' })).toBe('2500.0000');
    expect(resolveHighValueThreshold({ HITL_RECOVERY_THRESHOLD: 'abc' })).toBe(
      DEFAULT_HIGH_VALUE_THRESHOLD,
    );
    expect(resolveHighValueThreshold({ HITL_RECOVERY_THRESHOLD: '-5' })).toBe(
      DEFAULT_HIGH_VALUE_THRESHOLD,
    );
  });

  it('USD 严格大于阈值才卡口；等于阈值不卡；非 USD 一律卡口', () => {
    const threshold = '1000.0000';
    expect(requiresHighValueReview({ recoveredAmount: '999.9999', currency: 'USD', threshold })).toBe(false);
    expect(requiresHighValueReview({ recoveredAmount: '1000.0000', currency: 'USD', threshold })).toBe(false);
    expect(requiresHighValueReview({ recoveredAmount: '1000.0001', currency: 'USD', threshold })).toBe(true);
    // 非 USD：不做汇率，一律人工处理（架构方 Q2 裁定）
    expect(requiresHighValueReview({ recoveredAmount: '1.0000', currency: 'EUR', threshold })).toBe(true);
    expect(requiresHighValueReview({ recoveredAmount: '1.0000', currency: 'JPY', threshold })).toBe(true);
  });
});

describe('C-0009.2 — 审计推导状态与顺序不变量', () => {
  it('无事件 = NOT_REQUIRED；仅有 required = PENDING', () => {
    expect(resolveHighValueReviewState([])).toBe('NOT_REQUIRED');
    expect(resolveHighValueReviewState([{ action: REVIEW_ACTIONS.required, createdAt: at('2026-09-28T09:00:00Z') }])).toBe(
      'PENDING',
    );
  });

  it('required → approved = APPROVED；required → rejected = REJECTED', () => {
    expect(
      resolveHighValueReviewState([
        { action: REVIEW_ACTIONS.required, createdAt: at('2026-09-28T09:00:00Z') },
        { action: REVIEW_ACTIONS.approved, createdAt: at('2026-09-28T10:00:00Z') },
      ]),
    ).toBe('APPROVED');
    expect(
      resolveHighValueReviewState([
        { action: REVIEW_ACTIONS.required, createdAt: at('2026-09-28T09:00:00Z') },
        { action: REVIEW_ACTIONS.rejected, createdAt: at('2026-09-28T10:00:00Z') },
      ]),
    ).toBe('REJECTED');
  });

  it('顺序不变量：approved 早于最近一次 required ⇒ 视为未通过（PENDING）', () => {
    // 时间顺序：required(09:00) → approved(11:00) → required(12:00)
    expect(
      resolveHighValueReviewState([
        { action: REVIEW_ACTIONS.approved, createdAt: at('2026-09-28T11:00:00Z') },
        { action: REVIEW_ACTIONS.required, createdAt: at('2026-09-28T09:00:00Z') },
        { action: REVIEW_ACTIONS.required, createdAt: at('2026-09-28T12:00:00Z') },
      ]),
    ).toBe('PENDING');
  });
});

function fakePrisma(events: Array<{ action: string; createdAt: Date; actorUserId?: string | null }>, hasCase = true) {
  const auditCreate: ReturnType<typeof vi.fn> = vi.fn(async () => ({ id: 'audit-1' }));
  const tx = {
    auditLog: {
      findMany: vi.fn(async () => events),
      create: auditCreate,
    },
  };
  const transaction = vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx));
  return {
    prisma: {
      case: { findFirst: vi.fn(async () => (hasCase ? { id: CASE, caseNo: 'CASE-1' } : null)) },
      auditLog: { findMany: vi.fn(async () => events), create: auditCreate },
      $transaction: transaction,
    } as unknown as PrismaClient,
    auditCreate,
    transaction,
  };
}

const base = { organizationId: ORG, actorUserId: ACTOR, caseId: CASE } as const;

describe('C-0009.2 — 审批角色与状态机', () => {
  it('REQUEST 允许 OWNER/ADMIN/FINANCE；APPROVE/REJECT 只允许 OWNER/ADMIN', async () => {
    for (const role of ['OWNER', 'ADMIN', 'FINANCE']) {
      const { prisma } = fakePrisma([]);
      await expect(submitRecoveryReview(prisma, { ...base, role, decision: 'REQUEST' }, () => NOW)).resolves.toMatchObject(
        { decision: 'REQUEST', state: 'PENDING' },
      );
    }
    for (const role of ['FINANCE', 'OPS', 'VIEWER']) {
      const { prisma } = fakePrisma([
        { action: REVIEW_ACTIONS.required, createdAt: at('2026-09-28T09:00:00Z') },
      ]);
      await expect(
        submitRecoveryReview(prisma, { ...base, role, decision: 'APPROVE' }, () => NOW),
      ).rejects.toThrow(ForbiddenError);
    }
  });

  it('没有待审批请求时不能审批（NOT_REQUIRED / APPROVED 都拒绝）', async () => {
    const notRequired = fakePrisma([]);
    await expect(
      submitRecoveryReview(notRequired.prisma, { ...base, role: 'ADMIN', decision: 'APPROVE' }, () => NOW),
    ).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });

    const alreadyApproved = fakePrisma([
      { action: REVIEW_ACTIONS.required, createdAt: at('2026-09-28T09:00:00Z') },
      { action: REVIEW_ACTIONS.approved, createdAt: at('2026-09-28T10:00:00Z') },
    ]);
    await expect(
      submitRecoveryReview(alreadyApproved.prisma, { ...base, role: 'ADMIN', decision: 'APPROVE' }, () => NOW),
    ).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
  });

  it('REJECT 必须带 reason；APPROVE 写 approved 审计', async () => {
    const pending = () => fakePrisma([{ action: REVIEW_ACTIONS.required, createdAt: at('2026-09-28T09:00:00Z') }]);

    const noReason = pending();
    await expect(
      submitRecoveryReview(noReason.prisma, { ...base, role: 'ADMIN', decision: 'REJECT' }, () => NOW),
    ).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    expect(noReason.auditCreate).not.toHaveBeenCalled();

    const reject = pending();
    await expect(
      submitRecoveryReview(reject.prisma, { ...base, role: 'ADMIN', decision: 'REJECT', reason: '金额存疑' }, () => NOW),
    ).resolves.toMatchObject({ decision: 'REJECT', state: 'REJECTED' });
    expect(reject.auditCreate.mock.calls[0][0].data).toMatchObject({
      action: REVIEW_ACTIONS.rejected,
      entityType: 'Case',
      entityId: CASE,
      actorType: 'USER',
      actorUserId: ACTOR,
    });

    const approve = pending();
    await expect(
      submitRecoveryReview(approve.prisma, { ...base, role: 'OWNER', decision: 'APPROVE' }, () => NOW),
    ).resolves.toMatchObject({ decision: 'APPROVE', state: 'APPROVED' });
    expect(approve.auditCreate.mock.calls[0][0].data.action).toBe(REVIEW_ACTIONS.approved);
  });
});

describe('C-0009.2 — confirmRecoveryOutcome 前的资金闸门', () => {
  const gateInput = {
    organizationId: ORG,
    actorUserId: ACTOR,
    caseId: CASE,
    caseNo: 'CASE-1',
    currency: 'USD',
  } as const;

  it('未超阈值：直接放行，不写审计', async () => {
    const { prisma, auditCreate } = fakePrisma([]);
    await expect(
      assertHighValueReviewCleared(
        prisma,
        { ...gateInput, recoveredAmount: new Prisma.Decimal('999.0000') },
        () => NOW,
      ),
    ).resolves.toBeUndefined();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('超阈值且未审批：写 review_required 并抛 REVIEW_REQUIRED', async () => {
    const { prisma, auditCreate } = fakePrisma([]);
    await expect(
      assertHighValueReviewCleared(
        prisma,
        { ...gateInput, recoveredAmount: new Prisma.Decimal('1500.0000') },
        () => NOW,
      ),
    ).rejects.toMatchObject({ code: 'REVIEW_REQUIRED' });
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate.mock.calls[0][0].data).toMatchObject({
      action: REVIEW_ACTIONS.required,
      entityId: CASE,
      actorUserId: ACTOR,
    });
    expect(auditCreate.mock.calls[0][0].data.changes).toMatchObject({
      recoveredAmount: '1500.0000',
      currency: 'USD',
      threshold: DEFAULT_HIGH_VALUE_THRESHOLD,
    });
  });

  it('超阈值但已审批（approved 晚于 required）：放行', async () => {
    const { prisma, auditCreate } = fakePrisma([
      { action: REVIEW_ACTIONS.required, createdAt: at('2026-09-28T09:00:00Z') },
      { action: REVIEW_ACTIONS.approved, createdAt: at('2026-09-28T10:00:00Z') },
    ]);
    await expect(
      assertHighValueReviewCleared(
        prisma,
        { ...gateInput, recoveredAmount: new Prisma.Decimal('1500.0000') },
        () => NOW,
      ),
    ).resolves.toBeUndefined();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('非 USD 金额一律卡口（即便金额很小）', async () => {
    const { prisma } = fakePrisma([]);
    await expect(
      assertHighValueReviewCleared(
        prisma,
        { ...gateInput, currency: 'EUR', recoveredAmount: new Prisma.Decimal('10.0000') },
        () => NOW,
      ),
    ).rejects.toMatchObject({ code: 'REVIEW_REQUIRED' });
  });
});
