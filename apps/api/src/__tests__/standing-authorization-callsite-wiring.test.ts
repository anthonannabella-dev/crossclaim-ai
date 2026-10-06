// STANDING AUTHORIZATION — SA-3b — 真实调用点（HITL 提交边界 / Action Pack runtime）行为回归
// ---------------------------------------------------------------------------
// 覆盖真实入口：`createHitlSubmissionBoundary`（被 workflow/http-routes 的 6 处与 recovery/http-request 使用）
// 与 `runActionPack`（RSI Action Pack 执行链）——两者都已支持可选的 standingAuthorization 判定透传。

import { describe, expect, it, vi } from 'vitest';

import {
  ActionGuardApprovalVerificationError,
  type ActionGuardApprovalVerifier,
} from '../services/action-guard/approval-verifier';
import { createHitlSubmissionBoundary } from '../services/action-guard/hitl-submission';
import type { ActionGuardResult } from '../services/action-guard/action-guard';
import type { RuntimeActionGuard } from '../services/action-guard/runtime-guard';

const ACTION = 'recovery.manual_submit';

function requireApprovalGuard(): RuntimeActionGuard {
  const result: ActionGuardResult = {
    decision: 'REQUIRE_APPROVAL',
    code: 'ACTION_GUARD_HUMAN_APPROVAL_REQUIRED',
    action: ACTION,
    risk: 'INTERNAL_WRITE',
    reasons: ['缺少 approvalId'],
    requiredGates: ['humanApproval'],
  };
  return { async assertAllowed() { return result; } } as unknown as RuntimeActionGuard;
}

function verifier(valid: boolean): ActionGuardApprovalVerifier {
  return { async verify() { return valid ? { valid: true } : { valid: false, reason: 'APPROVAL_NOT_FOUND' }; } };
}

function boundary(approvalVerifier: ActionGuardApprovalVerifier, auditRows: unknown[] = []) {
  return createHitlSubmissionBoundary({
    guard: requireApprovalGuard(),
    approvals: approvalVerifier,
    audit: { write: (record: unknown) => void auditRows.push(record) },
  } as never);
}

const standingAllow = {
  decision: 'ALLOW' as const,
  authorizedBy: 'STANDING_AUTHORIZATION' as const,
  satisfiedGates: ['humanApproval'],
  action: ACTION,
};

describe('SA-3b — HITL 提交边界（真实入口）', () => {
  it('有效 Standing Authorization → perform 恰好执行一次（无需 approvalId），并写审批审计', async () => {
    const perform = vi.fn(async () => 'submitted');
    const auditRows: unknown[] = [];
    const result = await boundary(verifier(false), auditRows).submit({
      action: ACTION,
      organizationId: 'org-1',
      actorUserId: 'user-1',
      targetRef: 'case-1',
      standingAuthorization: standingAllow,
      perform,
    });
    expect(result).toBe('submitted');
    expect(perform).toHaveBeenCalledTimes(1);
    expect(auditRows.length).toBeGreaterThan(0);
  });

  it('授权 DENY（撤销/过期/不匹配）→ perform 零副作用并 fail-closed', async () => {
    const perform = vi.fn(async () => 'submitted');
    await expect(
      boundary(verifier(true)).submit({
        action: ACTION,
        organizationId: 'org-1',
        actorUserId: 'user-1',
        targetRef: 'case-1',
        standingAuthorization: { ...standingAllow, decision: 'DENY', authorizedBy: 'NONE' },
        perform,
      }),
    ).rejects.toBeInstanceOf(ActionGuardApprovalVerificationError);
    expect(perform).not.toHaveBeenCalled();
  });

  it('授权越权（声称满足非可绕过 gate）→ 抛 OVERREACH 且 perform 零副作用', async () => {
    const perform = vi.fn(async () => 'submitted');
    await expect(
      boundary(verifier(true)).submit({
        action: ACTION,
        organizationId: 'org-1',
        actorUserId: 'user-1',
        targetRef: 'case-1',
        standingAuthorization: { ...standingAllow, satisfiedGates: ['humanApproval', 'productionGate'] },
        perform,
      }),
    ).rejects.toBeInstanceOf(ActionGuardApprovalVerificationError);
    expect(perform).not.toHaveBeenCalled();
  });

  it('未提供授权时行为完全不变：审批通过 → 执行；审批不通过 → 拒绝且零副作用', async () => {
    const okPerform = vi.fn(async () => 'ok');
    await boundary(verifier(true)).submit({
      action: ACTION,
      organizationId: 'org-1',
      actorUserId: 'user-1',
      targetRef: 'case-1',
      approvalId: 'ap-1',
      perform: okPerform,
    });
    expect(okPerform).toHaveBeenCalledTimes(1);

    const blockedPerform = vi.fn(async () => 'never');
    await expect(
      boundary(verifier(false)).submit({
        action: ACTION,
        organizationId: 'org-1',
        actorUserId: 'user-1',
        targetRef: 'case-1',
        approvalId: 'ap-1',
        perform: blockedPerform,
      }),
    ).rejects.toBeInstanceOf(ActionGuardApprovalVerificationError);
    expect(blockedPerform).not.toHaveBeenCalled();
  });
});

describe('SA-3b — Action Pack runtime（RSI 执行链）接线存在性', () => {
  it('runActionPack 的类型契约包含可选 standingAuthorization，并把它透传给既有 approval verifier', async () => {
    const fs = await import('node:fs');
    const source = fs.readFileSync(
      'D:/crossclaim-ai/apps/api/src/services/action-runtime/action-pack-runtime.ts',
      'utf8',
    );
    expect(source).toContain('standingAuthorization?: {');
    expect(source).toContain('standingAuthorization: input.standingAuthorization ?? null');
    // 仍走既有共享 verifier（未新建第二套 Guard）
    expect(source).toContain('verifyApprovalOrThrow(');
  });
});

