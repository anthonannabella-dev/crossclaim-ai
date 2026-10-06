// STANDING AUTHORIZATION — SA-3 — 接入既有 approval-verifier / guard-enforcement 的验收回归
// ---------------------------------------------------------------------------
// 语义：`verifyApprovalOrThrow` 保留一次性 approvalId 路径不变；新增**可选** Standing Authorization 路径，
//   仅在调用方传入 wiring 层判定（decision=ALLOW 且 authorizedBy=STANDING_AUTHORIZATION 且
//   satisfiedGates 仅含 humanApproval 且 action 匹配）时放行；其余一律 fail-closed。
//   `withActionGuard` 透传该判定（未提供时行为与既有完全一致）。

import { describe, expect, it, vi } from 'vitest';

import {
  ActionGuardApprovalVerificationError,
  verifyApprovalOrThrow,
  type ActionGuardApprovalVerifier,
} from '../services/action-guard/approval-verifier';
import { withActionGuard } from '../services/action-guard/guard-enforcement';
import type { RuntimeActionGuard } from '../services/action-guard/runtime-guard';
import type { ActionGuardResult } from '../services/action-guard/action-guard';

const ACTION = 'recovery.manual_submit';
const ACTION_OTHER = 'claim.submit';

function query(action = ACTION) {
  return {
    approvalId: 'ap-1',
    organizationId: 'org-1',
    action,
    actorUserId: 'user-1',
  };
}

function okVerifier(): ActionGuardApprovalVerifier {
  return { async verify() { return { valid: true }; } };
}

function standingAllow(overrides: Record<string, unknown> = {}) {
  return {
    decision: 'ALLOW' as const,
    authorizedBy: 'STANDING_AUTHORIZATION' as const,
    satisfiedGates: ['humanApproval'],
    action: ACTION,
    ...overrides,
  };
}

async function reject(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'NO_ERROR';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('SA-3 — verifyApprovalOrThrow：授权替代路径（fail-closed）', () => {
  it('有效授权（仅 humanApproval、动作匹配）→ 通过，且标记 authorizedBy=STANDING_AUTHORIZATION（无需 approvalId 核验）', async () => {
    const decision = await verifyApprovalOrThrow({
      verifier: undefined,
      standingAuthorization: standingAllow(),
      query: query(),
    });
    expect(decision.valid).toBe(true);
    expect(decision.authorizedBy).toBe('STANDING_AUTHORIZATION');
  });

  it('授权越权（satisfiedGates 含非可绕过 gate）→ 抛 ACTION_GUARD_STANDING_AUTHORIZATION_OVERREACH', async () => {
    const message = await reject(() =>
      verifyApprovalOrThrow({
        verifier: okVerifier(),
        standingAuthorization: standingAllow({ satisfiedGates: ['humanApproval', 'productionGate'] }),
        query: query(),
      }),
    );
    expect(message).toMatch(/ACTION_GUARD_STANDING_AUTHORIZATION_OVERREACH/);
  });

  it('动作不匹配 → 抛 ACTION_GUARD_STANDING_AUTHORIZATION_ACTION_MISMATCH', async () => {
    const message = await reject(() =>
      verifyApprovalOrThrow({
        verifier: okVerifier(),
        standingAuthorization: standingAllow({ action: ACTION_OTHER }),
        query: query(),
      }),
    );
    expect(message).toMatch(/ACTION_GUARD_STANDING_AUTHORIZATION_ACTION_MISMATCH/);
  });

  it('授权判定 DENY（撤销 / 过期 / 不匹配）→ 抛 ACTION_GUARD_STANDING_AUTHORIZATION_DENIED（不回退到审批路径）', async () => {
    const message = await reject(() =>
      verifyApprovalOrThrow({
        verifier: okVerifier(),
        standingAuthorization: standingAllow({ decision: 'DENY', authorizedBy: 'NONE' }),
        query: query(),
      }),
    );
    expect(message).toMatch(/ACTION_GUARD_STANDING_AUTHORIZATION_DENIED/);
  });

  it('授权判定 REQUIRE_APPROVAL（超范围 / 高金额）→ 回退一次性审批路径', async () => {
    const missing = await reject(() =>
      verifyApprovalOrThrow({
        verifier: undefined,
        standingAuthorization: standingAllow({ decision: 'REQUIRE_APPROVAL', authorizedBy: 'NONE' }),
        query: query(),
      }),
    );
    expect(missing).toMatch(/ACTION_GUARD_APPROVAL_VERIFIER_MISSING/);

    const viaApproval = await verifyApprovalOrThrow({
      verifier: okVerifier(),
      standingAuthorization: standingAllow({ decision: 'REQUIRE_APPROVAL', authorizedBy: 'NONE' }),
      query: query(),
    });
    expect(viaApproval.valid).toBe(true);
    expect(viaApproval.authorizedBy).toBeUndefined();
  });

  it('既有行为不变：不传授权时，缺 verifier → VERIFIER_MISSING；verifier 无效 → 带 reason 抛错', async () => {
    expect(await reject(() => verifyApprovalOrThrow({ verifier: undefined, query: query() }))).toMatch(
      /ACTION_GUARD_APPROVAL_VERIFIER_MISSING/,
    );
    expect(
      await reject(() =>
        verifyApprovalOrThrow({
          verifier: { async verify() { return { valid: false, reason: 'APPROVAL_EXPIRED' }; } },
          query: query(),
        }),
      ),
    ).toMatch(/ACTION_GUARD_APPROVAL_NOT_VERIFIED/);
  });

  it('错误类型保持 ActionGuardApprovalVerificationError（调用方可按类型处理）', async () => {
    await expect(
      verifyApprovalOrThrow({
        verifier: okVerifier(),
        standingAuthorization: standingAllow({ satisfiedGates: ['killSwitch'] }),
        query: query(),
      }),
    ).rejects.toBeInstanceOf(ActionGuardApprovalVerificationError);
  });
});

describe('SA-3 — withActionGuard 透传（生产调用点）', () => {
  function guard(): RuntimeActionGuard {
    const result: ActionGuardResult = {
      decision: 'REQUIRE_APPROVAL',
      code: 'ACTION_GUARD_HUMAN_APPROVAL_REQUIRED',
      action: ACTION,
      risk: 'INTERNAL_WRITE',
      reasons: ['缺少 approvalId'],
      requiredGates: ['humanApproval'],
    };
    return {
      async assertAllowed() {
        return result;
      },
    } as unknown as RuntimeActionGuard;
  }

  const input = { action: ACTION, actorUserId: 'user-1', organizationId: 'org-1', approvalId: '' };

  it('授权路径放行 → work 恰好执行一次；审计写入', async () => {
    const work = vi.fn(async () => 'done');
    const auditRows: unknown[] = [];
    const result = await withActionGuard({
      guard: guard(),
      input,
      work,
      audit: { write: (record) => void auditRows.push(record) },
      standingAuthorization: standingAllow(),
    });
    expect(result).toBe('done');
    expect(work).toHaveBeenCalledTimes(1);
    expect(auditRows.length).toBeGreaterThan(0);
  });

  it('授权越权 → work 不执行（零副作用）并抛错', async () => {
    const work = vi.fn(async () => 'done');
    await expect(
      withActionGuard({
        guard: guard(),
        input,
        work,
        audit: { write: () => undefined },
        standingAuthorization: standingAllow({ satisfiedGates: ['productionGate'] }),
      }),
    ).rejects.toBeInstanceOf(ActionGuardApprovalVerificationError);
    expect(work).not.toHaveBeenCalled();
  });

  it('未提供授权时行为与既有完全一致（缺 verifier → work 不执行）', async () => {
    const work = vi.fn(async () => 'done');
    await expect(
      withActionGuard({ guard: guard(), input, work, audit: { write: () => undefined } }),
    ).rejects.toBeInstanceOf(ActionGuardApprovalVerificationError);
    expect(work).not.toHaveBeenCalled();
  });
});
