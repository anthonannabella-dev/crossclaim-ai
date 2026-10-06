// CUSTOMS / DUTY RECOVERY — slice B-S10 — Claim-Ready Package vNext + Customs high-value HITL 回归
// ---------------------------------------------------------------------------
// 覆盖：内层包非执行语义再断言、high-value HITL（>1000 → OWNER，≥10000 → ADMIN，不可绕过）、
//   三态处置（BLOCKED_BY_GAPS / NEEDS_HUMAN_APPROVAL / CLAIM_READY_FOR_HANDOFF）、
//   不申报不提交不计费、不伪称 3PL、边界断言、确定性摘要。

import { describe, expect, it } from 'vitest';

import * as vnextModule from '../services/customs/claim-ready-package-vnext';
import {
  CLAIM_READY_PACKAGE_VNEXT_VERSION,
  CLAIM_READY_VNEXT_BOUNDARY,
  CLAIM_READY_VNEXT_DISPOSITIONS,
  ClaimReadyVNextError,
  assembleClaimReadyPackageVNext,
  assertClaimReadyVNextIsNonExecuting,
  type ClaimReadyPackageVNextInput,
} from '../services/customs/claim-ready-package-vnext';
import type { CustomsClaimReadyPackage } from '../services/customs/customs-claim-ready-package';

const NOW = new Date('2026-10-06T21:00:00.000Z');
const SCOPE = { organizationId: 'org-cr-1', platformAccountId: 'acct-cr-a' };

function basePackage(overrides: Partial<CustomsClaimReadyPackage> = {}): CustomsClaimReadyPackage {
  return {
    packageId: 'pkg-1',
    entryNumber: 'ABC-123456',
    jurisdiction: 'US',
    readiness: 'READY',
    gaps: [],
    checklist: [],
    dutyTruth: { currencies: ['USD'], totalByCurrency: { USD: '1250.00' }, observations: [] },
    discrepancy: { itemCount: 1, codes: ['RATE_DIFF'], signedByCurrency: { USD: '312.50' } },
    eligibility: { status: 'ELIGIBLE', reasons: [], overpaymentCandidateByCurrency: { USD: '312.50' } },
    estimate: { status: 'ESTIMATED', byCurrency: [{ currency: 'USD', estimatedAmount: '312.50' }], estimateOnly: true, frozenAsTrustedAmount: false },
    evidenceReferences: [],
    provenance: { policyId: 'customs-us', policyVersion: 'v1', algorithmVersion: 'customs-package/v1' },
    inputDigest: 'a'.repeat(64),
    resultDigest: 'b'.repeat(64),
    computedAt: NOW.toISOString(),
    filingPerformed: false,
    submissionPerformed: false,
    transportEnabled: false,
    estimateOnly: true,
    billable: false,
    productionCredentials: 'ABSENT',
    ...overrides,
  } as CustomsClaimReadyPackage;
}

function assemble(overrides: Partial<ClaimReadyPackageVNextInput> = {}) {
  return assembleClaimReadyPackageVNext({
    scope: SCOPE,
    base: basePackage(),
    estimatedRecoverableAmountUsd: 500,
    now: NOW,
    ...overrides,
  });
}

describe('B-S10 vNext — 处置与 HITL', () => {
  it('基础包 READY 且金额低于阈值 → CLAIM_READY_FOR_HANDOFF（仍不申报不计费）', () => {
    const vnext = assemble();
    expect(vnext.kind).toBe('CUSTOMS_CLAIM_READY_PACKAGE_VNEXT');
    expect(vnext.version).toBe(CLAIM_READY_PACKAGE_VNEXT_VERSION);
    expect(vnext.disposition).toBe('CLAIM_READY_FOR_HANDOFF');
    expect(vnext.hitl.required).toBe(false);
    expect(vnext.hitl.role).toBeNull();
    expect(vnext.reasonCodes).toContain('READY_FOR_BROKER_HANDOFF');
    expect(vnext.nonExecution.filingPerformed).toBe(false);
    expect(vnext.nonExecution.billable).toBe(false);
    expect(vnext.nonExecution.estimateOnly).toBe(true);
    expect(vnext.nonExecution.allowsAutoFiling).toBe(false);
    expect(() => assertClaimReadyVNextIsNonExecuting(vnext)).not.toThrow();
  });

  it('金额 > 1000 USD → NEEDS_HUMAN_APPROVAL，角色 OWNER，不可绕过', () => {
    const vnext = assemble({ estimatedRecoverableAmountUsd: 1_500 });
    expect(vnext.disposition).toBe('NEEDS_HUMAN_APPROVAL');
    expect(vnext.hitl.required).toBe(true);
    expect(vnext.hitl.role).toBe('OWNER');
    expect(vnext.hitl.satisfied).toBe(false);
    expect(vnext.hitl.cannotBypass).toBe(true);
    expect(vnext.hitl.reasons).toContain('HIGH_VALUE_CUSTOMS_CLAIM');
    expect(vnext.reasonCodes).toContain('HIGH_VALUE_HITL_REQUIRED');
  });

  it('金额 ≥ 10000 USD → 角色升为 ADMIN', () => {
    const vnext = assemble({ estimatedRecoverableAmountUsd: 25_000 });
    expect(vnext.hitl.role).toBe('ADMIN');
    expect(vnext.hitl.reasons).toContain('ABOVE_ADMIN_THRESHOLD');
  });

  it('OWNER 审批后 → CLAIM_READY_FOR_HANDOFF，并记录审批人', () => {
    const vnext = assemble({
      estimatedRecoverableAmountUsd: 1_500,
      approvals: [{ approvalId: 'ap-1', role: 'OWNER', approvedAt: '2026-10-06T20:00:00.000Z' }],
    });
    expect(vnext.disposition).toBe('CLAIM_READY_FOR_HANDOFF');
    expect(vnext.hitl.satisfied).toBe(true);
    expect(vnext.hitl.approvedBy.map((a) => a.approvalId)).toEqual(['ap-1']);
    expect(vnext.reasonCodes).toContain('HIGH_VALUE_HITL_SATISFIED');
  });

  it('REVIEWER 审批不能替代 OWNER/ADMIN（角色不足 → 仍需人工）', () => {
    const onlyReviewer = assemble({
      estimatedRecoverableAmountUsd: 25_000,
      approvals: [{ approvalId: 'ap-r', role: 'REVIEWER', approvedAt: '2026-10-06T20:00:00.000Z' }],
    });
    expect(onlyReviewer.disposition).toBe('NEEDS_HUMAN_APPROVAL');
    expect(onlyReviewer.hitl.satisfied).toBe(false);

    const adminApproval = assemble({
      estimatedRecoverableAmountUsd: 25_000,
      approvals: [{ approvalId: 'ap-a', role: 'ADMIN', approvedAt: '2026-10-06T20:00:00.000Z' }],
    });
    expect(adminApproval.disposition).toBe('CLAIM_READY_FOR_HANDOFF');
  });

  it('金额未知（null）→ 不触发高价值分流（保守地不擅自升级）', () => {
    const vnext = assemble({ estimatedRecoverableAmountUsd: null });
    expect(vnext.hitl.required).toBe(false);
    expect(vnext.hitl.amountUsd).toBeNull();
    expect(vnext.disposition).toBe('CLAIM_READY_FOR_HANDOFF');
  });

  it('基础包 NOT_READY → BLOCKED_BY_GAPS（即使金额高价值）', () => {
    const vnext = assemble({
      base: basePackage({ readiness: 'NOT_READY', gaps: ['ESTIMATE_NOT_READY'] }),
      estimatedRecoverableAmountUsd: 5_000,
    });
    expect(vnext.disposition).toBe('BLOCKED_BY_GAPS');
    expect(vnext.gaps).toEqual(['ESTIMATE_NOT_READY']);
    expect(vnext.reasonCodes).toContain('BASE_PACKAGE_HAS_GAPS');
    expect(vnext.hitl.reasons).toContain('BASE_PACKAGE_NOT_READY');
  });

  it('阈值可覆盖（调用方策略）', () => {
    const vnext = assemble({ estimatedRecoverableAmountUsd: 1_500, highValueThresholdUsd: 10_000 });
    expect(vnext.hitl.required).toBe(false);
    expect(vnext.hitl.thresholdUsd).toBe(10_000);
  });
});

describe('B-S10 — fail-closed 输入与制度边界', () => {
  it('显式请求绕过 HITL → fail-closed', () => {
    expect(() => assemble({ estimatedRecoverableAmountUsd: 5_000, requestBypassHighValueHitl: true })).toThrowError(
      ClaimReadyVNextError,
    );
    try {
      assemble({ requestBypassHighValueHitl: true });
    } catch (error) {
      expect((error as { code?: string }).code).toBe('CLAIM_READY_VNEXT_CANNOT_BYPASS_HITL');
    }
  });

  it('内层包声称已申报 / 已提交 / 可计费 / 非估算 → 拒绝装配', () => {
    expect(() => assemble({ base: basePackage({ filingPerformed: true as never }) })).toThrowError(
      ClaimReadyVNextError,
    );
    expect(() => assemble({ base: basePackage({ submissionPerformed: true as never }) })).toThrowError(
      ClaimReadyVNextError,
    );
    expect(() => assemble({ base: basePackage({ billable: true as never }) })).toThrowError(ClaimReadyVNextError);
    expect(() => assemble({ base: basePackage({ estimateOnly: false as never }) })).toThrowError(
      ClaimReadyVNextError,
    );
    expect(() => assemble({ base: basePackage({ transportEnabled: true as never }) })).toThrowError(
      ClaimReadyVNextError,
    );
  });

  it('伪称 3PL 对账已完成 → fail-closed', () => {
    expect(() => assemble({ thirdPartyLogisticsReconciliationPerformed: true })).toThrowError(
      ClaimReadyVNextError,
    );
    try {
      assemble({ thirdPartyLogisticsReconciliationPerformed: true });
    } catch (error) {
      expect((error as { code?: string }).code).toBe('CLAIM_READY_VNEXT_CANNOT_CLAIM_3PL');
    }
  });

  it('包内 3PL 字段恒为「未发生 / 不得声称完成」', () => {
    const vnext = assemble();
    expect(vnext.thirdPartyLogistics.reconciliationPerformed).toBe(false);
    expect(vnext.thirdPartyLogistics.mayClaimCompleted).toBe(false);
    expect(vnext.thirdPartyLogistics.note).toContain('3PL');
  });

  it('边界常量：非执行、非计费、纯估算、HITL 不可绕过、3PL 不得声称', () => {
    expect(CLAIM_READY_VNEXT_BOUNDARY.estimateOnly).toBe(true);
    expect(CLAIM_READY_VNEXT_BOUNDARY.billable).toBe(false);
    expect(CLAIM_READY_VNEXT_BOUNDARY.filingPerformed).toBe(false);
    expect(CLAIM_READY_VNEXT_BOUNDARY.submissionPerformed).toBe(false);
    expect(CLAIM_READY_VNEXT_BOUNDARY.transportEnabled).toBe(false);
    expect(CLAIM_READY_VNEXT_BOUNDARY.allowsAutoFiling).toBe(false);
    expect(CLAIM_READY_VNEXT_BOUNDARY.productionCredentials).toBe('ABSENT');
    expect(CLAIM_READY_VNEXT_BOUNDARY.computesRecoverableAmount).toBe(false);
    expect(CLAIM_READY_VNEXT_BOUNDARY.highValueHitlCannotBeBypassed).toBe(true);
    expect(CLAIM_READY_VNEXT_BOUNDARY.thirdPartyLogisticsClaimForbidden).toBe(true);
    expect(CLAIM_READY_VNEXT_BOUNDARY.forbidden).toContain('billing on an estimate');
    expect(CLAIM_READY_VNEXT_BOUNDARY.forbidden).toContain('claiming that a 3PL reconciliation was completed');
  });

  it('assertClaimReadyVNextIsNonExecuting：真实包通过；伪造执行语义/3PL/非法处置 → 拒绝', () => {
    const vnext = assemble();
    expect(() => assertClaimReadyVNextIsNonExecuting(vnext)).not.toThrow();
    expect(() =>
      assertClaimReadyVNextIsNonExecuting({
        nonExecution: { estimateOnly: true, billable: true, filingPerformed: false, submissionPerformed: false, transportEnabled: false, allowsAutoFiling: false },
      }),
    ).toThrowError(ClaimReadyVNextError);
    expect(() =>
      assertClaimReadyVNextIsNonExecuting({
        nonExecution: { estimateOnly: true, billable: false, filingPerformed: true, submissionPerformed: false, transportEnabled: false, allowsAutoFiling: false },
      }),
    ).toThrowError(ClaimReadyVNextError);
    expect(() => assertClaimReadyVNextIsNonExecuting({ thirdPartyLogistics: { mayClaimCompleted: true } })).toThrowError(
      ClaimReadyVNextError,
    );
    expect(() => assertClaimReadyVNextIsNonExecuting({ disposition: 'FILED' as never })).toThrowError(
      ClaimReadyVNextError,
    );
    expect(CLAIM_READY_VNEXT_DISPOSITIONS).not.toContain('FILED' as never);
  });

  it('确定性：同输入同 now → 同 vnextDigest；金额变化 → 摘要变', () => {
    const a = assemble();
    const b = assemble();
    const c = assemble({ estimatedRecoverableAmountUsd: 1_500 });
    expect(a.vnextDigest).toBe(b.vnextDigest);
    expect(a.vnextDigest).not.toBe(c.vnextDigest);
    expect(a.vnextDigest).toHaveLength(64);
    expect(a.evaluatedAt).toBe(NOW.toISOString());
    expect(a.baseDigests.inputDigest).toBe('a'.repeat(64));
  });

  it('模块不导出任何申报 / 提交 / 计费入口', () => {
    const exportedNames = Object.keys(vnextModule);
    for (const name of exportedNames) {
      expect(name).not.toMatch(/submitClaim|fileClaim|chargeFee|billCustomer/i);
    }
  });
});
