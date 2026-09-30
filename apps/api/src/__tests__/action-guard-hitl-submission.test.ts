// HITL submission boundary 单测（授权项 ② 第一批冻结条件）

import { describe, expect, it } from 'vitest';
import { createHitlSubmissionBoundary } from '../services/action-guard/hitl-submission';
import { createRuntimeActionGuard } from '../services/action-guard/runtime-guard';

const ORG = 'b2a00000-0000-4000-8000-0000000000aa';
const ACTOR = 'b2b00000-0000-4000-8000-0000000000bb';
const CASE = 'b2c00000-0000-4000-8000-0000000000cc';

const satisfied = {
  tenantEnabled: true,
  writeEnabled: true,
  featureEnabled: { 'commission.charge': true },
  platformEnablement: { 'commission.charge': true },
  productionGate: 'SATISFIED' as const,
  hostApprovalGranted: true,
};

function boundary(caps: unknown, approvalState: 'APPROVED' | 'PENDING' | 'REJECTED' | 'NOT_REQUIRED', auditThrows = false) {
  const events: unknown[] = [];
  const guard = createRuntimeActionGuard({
    capabilities: { resolve: async () => caps as never },
    audit: {
      write: (record) => {
        if (auditThrows) throw new Error('audit sink down');
        events.push(record);
      },
    },
  });
  const b = createHitlSubmissionBoundary({
    guard,
    approvalVerifier: {
      prisma: undefined as never,
      readReviewState: async () => approvalState,
    },
  } as never);
  return { boundary: b, events };
}

function run(b: ReturnType<typeof boundary>['boundary'], perform: () => void, approvalId: string | undefined = 'appr-1') {
  return b.submit({
    action: 'commission.charge',
    organizationId: ORG,
    actorUserId: ACTOR,
    targetRef: CASE,
    approvalId,
    perform,
  });
}

describe('HITL submission boundary', () => {
  it('01 闸门 + 审批全通过：perform 恰好执行一次', async () => {
    const { boundary: b, events } = boundary(satisfied, 'APPROVED');
    let calls = 0;
    await run(b, () => {
      calls += 1;
    });
    expect(calls).toBe(1);
    expect(events).toHaveLength(1);
  });

  it('02 审批未通过（PENDING / REJECTED / 无记录）：perform 零执行', async () => {
    for (const state of ['PENDING', 'REJECTED', 'NOT_REQUIRED'] as const) {
      const { boundary: b } = boundary(satisfied, state);
      let calls = 0;
      await expect(run(b, () => (calls += 1))).rejects.toMatchObject({ name: 'ActionGuardApprovalVerificationError' });
      expect(calls, state).toBe(0);
    }
  });

  it('03 缺 approvalId → REQUIRE_APPROVAL，perform 零执行', async () => {
    const { boundary: b } = boundary(satisfied, 'APPROVED');
    let calls = 0;
    await expect(
      b.submit({
        action: 'commission.charge',
        organizationId: ORG,
        actorUserId: ACTOR,
        targetRef: CASE,
        perform: () => {
          calls += 1;
        },
      }),
    ).rejects.toMatchObject({ name: 'ActionGuardApprovalRequiredError' });
    expect(calls).toBe(0);
  });

  it('04 闸门不满足（能力缺失）→ DENY，perform 零执行', async () => {
    const { boundary: b } = boundary(undefined, 'APPROVED');
    let calls = 0;
    await expect(run(b, () => (calls += 1))).rejects.toMatchObject({ code: 'ACTION_GUARD_STATE_UNAVAILABLE' });
    expect(calls).toBe(0);
  });

  it('05 审计异常 → ALLOW 降级为 DENY，perform 零执行', async () => {
    const { boundary: b } = boundary(satisfied, 'APPROVED', true);
    let calls = 0;
    await expect(run(b, () => (calls += 1))).rejects.toMatchObject({ code: 'ACTION_GUARD_AUDIT_UNAVAILABLE' });
    expect(calls).toBe(0);
  });

  it('06 重试/重复调用：每次都重新核验审批（第二次改为未批准 → 拒绝且不再执行）', async () => {
    let state: 'APPROVED' | 'PENDING' = 'APPROVED';
    const { boundary: b } = boundary(satisfied, 'APPROVED');
    // 用一个可变的审批源替换默认 verifier 以模拟状态变化
    const dynamic = createHitlSubmissionBoundary({
      guard: createRuntimeActionGuard({
        capabilities: { resolve: async () => satisfied as never },
        audit: { write: () => {} },
      }),
      approvalVerifier: { prisma: undefined as never, readReviewState: async () => state },
    } as never);
    let calls = 0;
    await run(dynamic, () => (calls += 1));
    expect(calls).toBe(1);
    state = 'PENDING';
    await expect(run(dynamic, () => (calls += 1))).rejects.toMatchObject({ reason: 'APPROVAL_NOT_APPROVED' });
    expect(calls).toBe(1);
    void b;
  });

  it('07 依赖缺失即失败（不允许无守卫/无审批源直接执行）', () => {
    expect(() => createHitlSubmissionBoundary({ guard: undefined as never, prisma: {} as never })).toThrow(
      'HITL_SUBMISSION_MISSING_GUARD',
    );
  });
});
