// 审批绑定校验单测（授权项 ② 第一批；MSG-20260930-16 §6）

import { describe, expect, it } from 'vitest';
import {
  APPROVAL_REASON_CODES,
  actionRequiresHumanApproval,
  verifyApprovalOrThrow,
} from '../services/action-guard/approval-verifier';
import { withActionGuard } from '../services/action-guard/guard-enforcement';
import { createRuntimeActionGuard } from '../services/action-guard/runtime-guard';

const ORG = 'b2a00000-0000-4000-8000-0000000000aa';
const ACTOR = 'b2b00000-0000-4000-8000-0000000000bb';

const satisfied = {
  tenantEnabled: true,
  writeEnabled: true,
  featureEnabled: { 'claim.submit': true },
  platformEnablement: { 'claim.submit': true },
  productionGate: 'SATISFIED' as const,
  hostApprovalGranted: true,
};

function guard() {
  return createRuntimeActionGuard({
    capabilities: { resolve: async () => satisfied },
    audit: { write: () => {} },
  });
}

const query = { approvalId: 'appr-1', organizationId: ORG, action: 'claim.submit', actorUserId: ACTOR };

describe('Approval binding verification', () => {
  it('01 目录驱动：仅 humanApproval 动作需要校验', () => {
    expect(actionRequiresHumanApproval('claim.submit')).toBe(true);
    expect(actionRequiresHumanApproval('appeal.submit')).toBe(true);
    expect(actionRequiresHumanApproval('evidence.read')).toBe(false);
    expect(actionRequiresHumanApproval('toString')).toBe(false);
    expect(actionRequiresHumanApproval('not.registered')).toBe(false);
  });

  it('02 verifier 缺失 → VERIFIER_MISSING（fail closed）', async () => {
    await expect(verifyApprovalOrThrow({ verifier: undefined, query })).rejects.toMatchObject({
      code: 'ACTION_GUARD_APPROVAL_VERIFIER_MISSING',
      reason: 'VERIFIER_MISSING',
    });
  });

  it('03 verifier 抛异常 → 不吞，转 VERIFIER_ERROR', async () => {
    await expect(
      verifyApprovalOrThrow({
        verifier: { async verify() { throw new Error('db down'); } },
        query,
      }),
    ).rejects.toMatchObject({ code: 'ACTION_GUARD_APPROVAL_NOT_VERIFIED', reason: 'VERIFIER_ERROR' });
  });

  it('04 全部拒绝原因码可透传（租户/动作/主体/目标/过期/撤销/已消费/不存在）', async () => {
    for (const reason of APPROVAL_REASON_CODES) {
      await expect(
        verifyApprovalOrThrow({ verifier: { async verify() { return { valid: false, reason }; } }, query }),
      ).rejects.toMatchObject({ code: 'ACTION_GUARD_APPROVAL_NOT_VERIFIED', reason });
    }
  });

  it('05 未知原因码按 VERIFIER_ERROR（不猜测、不放行）', async () => {
    await expect(
      verifyApprovalOrThrow({
        verifier: { async verify() { return { valid: false, reason: 'WHATEVER' as never }; } },
        query,
      }),
    ).rejects.toMatchObject({ reason: 'VERIFIER_ERROR' });
  });

  it('06 校验通过才返回 decision', async () => {
    const decision = await verifyApprovalOrThrow({
      verifier: { async verify() { return { valid: true, expiresAt: '2026-09-30T12:00:00.000Z' }; } },
      query,
    });
    expect(decision.valid).toBe(true);
  });

  it('07 wrapper：需要审批的动作在 approvalId + 全闸门满足下，仍需 verifier 通过才执行（恰好一次）', async () => {
    let calls = 0;
    const result = await withActionGuard({
      guard: guard(),
      input: { action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'appr-1' },
      approvals: { async verify() { return { valid: true }; } },
      // CHANGE D：放行路径必须提供审批审计端口
      audit: { write: () => {} },
      work: (decision) => {
        calls += 1;
        return decision.code;
      },
    });
    expect(calls).toBe(1);
    expect(result).toBe('ACTION_GUARD_ALLOWED');
  });

  it('08 wrapper：verifier 缺失或校验失败时 work=0（审批不得仅凭 approvalId 放行）', async () => {
    for (const approvals of [undefined, { async verify() { return { valid: false, reason: 'APPROVAL_EXPIRED' as const }; } }]) {
      let calls = 0;
      await expect(
        withActionGuard({
          guard: guard(),
          input: { action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'appr-1' },
          approvals,
          work: () => {
            calls += 1;
          },
        }),
      ).rejects.toMatchObject({ name: 'ActionGuardApprovalVerificationError' });
      expect(calls).toBe(0);
    }
  });

  it('09 wrapper：不需要审批的动作不触发 verifier（只读/内部写）', async () => {
    let verified = 0;
    let calls = 0;
    await withActionGuard({
      guard: createRuntimeActionGuard({
        capabilities: { resolve: async () => ({ tenantEnabled: true, featureEnabled: { 'claim.prepare': true, 'evidence.read': true }, productionGate: 'NOT_SATISFIED' }) },
        audit: { write: () => {} },
      }),
      input: { action: 'evidence.read', actorUserId: ACTOR, organizationId: ORG },
      approvals: { async verify() { verified += 1; return { valid: true }; } },
      work: () => {
        calls += 1;
      },
    });
    expect(verified).toBe(0);
    expect(calls).toBe(1);
  });
});
