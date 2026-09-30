// HITL submission boundary 单测（v3：注入 approvals 校验器；授权项 ② R1 冻结条件）

import { describe, expect, it } from 'vitest';
import { createHitlSubmissionBoundary } from '../services/action-guard/hitl-submission';
import { createRuntimeActionGuard } from '../services/action-guard/runtime-guard';
import type { ActionGuardApprovalVerifier } from '../services/action-guard/approval-verifier';

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

type ApprovalOutcome = { valid: true } | { valid: false; reason: 'APPROVAL_NOT_APPROVED' | 'APPROVAL_PAYLOAD_MISMATCH' };

function boundary(caps: unknown, approval: ApprovalOutcome, auditThrows = false, verifierThrows = false) {
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
  const approvals: ActionGuardApprovalVerifier = {
    async verify() {
      if (verifierThrows) throw new Error('approval source down');
      return approval;
    },
  };
  return {
    boundary: createHitlSubmissionBoundary({ guard, prisma: undefined as never, approvals }),
    events,
  };
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

describe('HITL submission boundary (v3)', () => {
  it('01 闸门 + 审批全通过：perform 恰好执行一次', async () => {
    const { boundary: b, events } = boundary(satisfied, { valid: true });
    let calls = 0;
    await run(b, () => {
      calls += 1;
    });
    expect(calls).toBe(1);
    expect(events).toHaveLength(1);
  });

  it('02 审批未通过：perform 零执行（含 payload 不匹配）', async () => {
    for (const approval of [{ valid: false, reason: 'APPROVAL_NOT_APPROVED' }, { valid: false, reason: 'APPROVAL_PAYLOAD_MISMATCH' }] as ApprovalOutcome[]) {
      const { boundary: b } = boundary(satisfied, approval);
      let calls = 0;
      await expect(run(b, () => (calls += 1))).rejects.toMatchObject({ name: 'ActionGuardApprovalVerificationError' });
      expect(calls, JSON.stringify(approval)).toBe(0);
    }
  });

  it('03 缺 approvalId → REQUIRE_APPROVAL，perform 零执行', async () => {
    const { boundary: b } = boundary(satisfied, { valid: true });
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
    const { boundary: b } = boundary(undefined, { valid: true });
    let calls = 0;
    await expect(run(b, () => (calls += 1))).rejects.toMatchObject({ code: 'ACTION_GUARD_STATE_UNAVAILABLE' });
    expect(calls).toBe(0);
  });

  it('05 审计异常 → ALLOW 降级为 DENY，perform 零执行', async () => {
    const { boundary: b } = boundary(satisfied, { valid: true }, true);
    let calls = 0;
    await expect(run(b, () => (calls += 1))).rejects.toMatchObject({ code: 'ACTION_GUARD_AUDIT_UNAVAILABLE' });
    expect(calls).toBe(0);
  });

  it('06 审批源异常（verifier 抛错）→ 拒绝且 perform 零执行', async () => {
    const { boundary: b } = boundary(satisfied, { valid: true }, false, true);
    let calls = 0;
    await expect(run(b, () => (calls += 1))).rejects.toMatchObject({ reason: 'VERIFIER_ERROR' });
    expect(calls).toBe(0);
  });

  it('07 重试重新核验：第二次改为未批准 → 拒绝且不再执行', async () => {
    let outcome: ApprovalOutcome = { valid: true };
    const guard = createRuntimeActionGuard({
      capabilities: { resolve: async () => satisfied as never },
      audit: { write: () => {} },
    });
    const b = createHitlSubmissionBoundary({
      guard,
      prisma: undefined as never,
      approvals: { async verify() { return outcome; } },
    });
    let calls = 0;
    await run(b, () => (calls += 1));
    expect(calls).toBe(1);
    outcome = { valid: false, reason: 'APPROVAL_NOT_APPROVED' };
    await expect(run(b, () => (calls += 1))).rejects.toMatchObject({ reason: 'APPROVAL_NOT_APPROVED' });
    expect(calls).toBe(1);
  });

  it('08 依赖缺失即失败（无守卫/无审批源不得执行）', () => {
    expect(() => createHitlSubmissionBoundary({ guard: undefined as never, prisma: {} as never })).toThrow(
      'HITL_SUBMISSION_MISSING_GUARD',
    );
    expect(() => createHitlSubmissionBoundary({ guard: createRuntimeActionGuard({ capabilities: { resolve: async () => satisfied as never }, audit: { write: () => {} } }), prisma: undefined as never })).toThrow(
      'HITL_SUBMISSION_MISSING_APPROVAL_SOURCE',
    );
  });
});
