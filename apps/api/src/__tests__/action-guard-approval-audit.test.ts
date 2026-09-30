// CHANGE D：审批核验结果单独成审计记录（可关联 approvalId/执行主体/目标/操作）

import { describe, expect, it } from 'vitest';
import { withActionGuard } from '../services/action-guard/guard-enforcement';
import { createRuntimeActionGuard } from '../services/action-guard/runtime-guard';

const ORG = 'b2a00000-0000-4000-8000-0000000000aa';
const ACTOR = 'b2b00000-0000-4000-8000-0000000000bb';
const CASE = 'b2c00000-0000-4000-8000-0000000000cc';

const satisfied = {
  tenantEnabled: true,
  writeEnabled: true,
  featureEnabled: { 'claim.submit': true },
  platformEnablement: { 'claim.submit': true },
  productionGate: 'SATISFIED' as const,
  hostApprovalGranted: true,
};

function harness(approval: { valid: true } | { valid: false; reason: 'APPROVAL_EXPIRED' }) {
  const policyEvents: unknown[] = [];
  const approvalEvents: unknown[] = [];
  const guard = createRuntimeActionGuard({
    capabilities: { resolve: async () => satisfied },
    audit: { write: (record) => void policyEvents.push(record) },
  });
  return {
    policyEvents,
    approvalEvents,
    run: () =>
      withActionGuard({
        guard,
        input: { action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'appr-1' },
        approvals: { async verify() { return approval; } },
        approvalTargetRef: CASE,
        approvalPayload: { recoveredAmount: '1.0000', currency: 'USD', basisReference: 'b', evidenceArtifactId: null },
        operationId: 'op-1',
        audit: { write: (record) => void approvalEvents.push(record) },
        work: () => 'done',
      }),
  };
}

describe('Approval verification audit (CHANGE D)', () => {
  it('01 通过：写入 action_guard.approval_decision（VERIFIED）且含关联字段', async () => {
    const h = harness({ valid: true });
    await h.run();
    expect(h.approvalEvents).toHaveLength(1);
    expect(h.approvalEvents[0]).toMatchObject({
      action: 'action_guard.approval_decision',
      code: 'ACTION_GUARD_APPROVAL_VERIFIED',
      decision: 'ALLOW',
      actionName: 'claim.submit',
      organizationId: ORG,
      actorUserId: ACTOR,
      approvalId: 'appr-1',
    });
    expect(h.policyEvents).toHaveLength(1); // 策略层审计仍独立存在
  });

  it('02 拒绝：写入 DENY 记录，reason 独立字段 + reasonCodes 仅含原因', async () => {
    const h = harness({ valid: false, reason: 'APPROVAL_EXPIRED' });
    await expect(h.run()).rejects.toMatchObject({ name: 'ActionGuardApprovalVerificationError' });
    expect(h.approvalEvents).toHaveLength(1);
    const record = h.approvalEvents[0] as {
      code: string;
      decision: string;
      reasonCodes: string[];
      reason: string | null;
      operationId: string | null;
      targetRef: string | null;
    };
    expect(record.code).toBe('ACTION_GUARD_APPROVAL_NOT_VERIFIED');
    expect(record.decision).toBe('DENY');
    expect(record.reason).toBe('APPROVAL_EXPIRED');
    expect(record.reasonCodes).toEqual(['APPROVAL_EXPIRED']);
    expect(record.operationId).toBe('op-1');
    expect(record.targetRef).toBe(CASE);
  });

  it('03 未注入审批审计端口（放行路径）：拒绝且 work=0（CHANGE D 失败关闭）', async () => {
    const guard = createRuntimeActionGuard({
      capabilities: { resolve: async () => satisfied },
      audit: { write: () => {} },
    });
    let calls = 0;
    await expect(
      withActionGuard({
        guard,
        input: { action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'appr-1' },
        approvals: { async verify() { return { valid: true }; } },
        approvalTargetRef: CASE,
        work: () => {
          calls += 1;
        },
      }),
    ).rejects.toMatchObject({ code: 'ACTION_GUARD_APPROVAL_AUDIT_UNAVAILABLE' });
    expect(calls).toBe(0);
  });

  it('04 审批审计写入失败：拒绝且 work=0', async () => {
    const guard = createRuntimeActionGuard({
      capabilities: { resolve: async () => satisfied },
      audit: { write: () => {} },
    });
    let calls = 0;
    await expect(
      withActionGuard({
        guard,
        input: { action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'appr-1' },
        approvals: { async verify() { return { valid: true }; } },
        approvalTargetRef: CASE,
        audit: {
          write: () => {
            throw new Error('audit sink down');
          },
        },
        work: () => {
          calls += 1;
        },
      }),
    ).rejects.toThrow('audit sink down');
    expect(calls).toBe(0);
  });
});
