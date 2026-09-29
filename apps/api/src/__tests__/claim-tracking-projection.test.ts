/**
 * Claim Tracking 只读投影与不变量（Phase B 实现，纯离线）
 */

import { describe, expect, it } from 'vitest';

import {
  buildClaimTimeline,
  canEnterRecoveryOutcome,
  checkClaimInvariants,
  listExpiringClaims,
  type ClaimProjectionInput,
} from '../services/claims/tracking-projection';

const NOW = new Date('2026-09-29T12:00:00Z');

function claim(overrides: Partial<ClaimProjectionInput> = {}): ClaimProjectionInput {
  return {
    id: 'claim-1',
    organizationId: 'org-1',
    caseId: 'case-1',
    round: 1,
    status: 'SUBMITTED',
    target: 'PLATFORM',
    dueAt: new Date('2026-10-10T00:00:00Z'),
    deadlineSource: 'PLATFORM_NOTICE',
    submittedAt: new Date('2026-09-20T00:00:00Z'),
    submittedBy: 'user-owner',
    respondedAt: null,
    responseAmount: null,
    platformCaseRef: null,
    approvedByUserId: null,
    approvedAt: null,
    terminalReasonCode: null,
    ...overrides,
  };
}

describe('Claim Tracking · 只读投影与不变量', () => {
  it('01 时间轴：审计事件优先，Claim 字段补齐历史（按时间倒序）', () => {
    const entries = buildClaimTimeline(claim({ respondedAt: new Date('2026-09-25T00:00:00Z') }), [
      {
        at: new Date('2026-09-21T00:00:00Z'),
        action: 'claim.acknowledged',
        actorUserId: 'user-ops',
        from: 'SUBMITTED',
        to: 'ACKNOWLEDGED',
        ref: 'AMZ-CASE-1',
      },
    ]);
    expect(entries[0].at).toBe('2026-09-25T00:00:00.000Z');
    expect(entries.map((entry) => entry.kind)).toContain('claim.acknowledged');
    expect(entries.map((entry) => entry.kind)).toContain('claim.submitted');
  });

  it('02 时间轴不重复：同一时刻同一事件只出现一次', () => {
    const at = new Date('2026-09-20T00:00:00Z');
    const entries = buildClaimTimeline(claim({ submittedAt: at }), [
      { at, action: 'claim.submitted', actorUserId: 'user-owner', from: 'DRAFT', to: 'SUBMITTED' },
    ]);
    expect(entries.filter((entry) => entry.kind === 'claim.submitted')).toHaveLength(1);
  });

  it('03 I1：有 dueAt 无来源 → 违规；只有 UNKNOWN 来源可无日期', () => {
    expect(checkClaimInvariants(claim({ deadlineSource: null })).map((v) => v.code)).toContain(
      'I1_DEADLINE_SOURCE_MISSING',
    );
    expect(
      checkClaimInvariants(claim({ dueAt: null, deadlineSource: 'UNKNOWN' })).map((v) => v.code),
    ).not.toContain('I1_DEADLINE_WITHOUT_DATE');
  });

  it('04 I2/I3/I4/I5：终局态必须齐备留痕与金额，且不得留 open deadline', () => {
    const bad = claim({
      status: 'PARTIALLY_APPROVED',
      responseAmount: null,
      approvedByUserId: null,
      approvedAt: null,
      terminalReasonCode: 'PLATFORM_DECISION',
    });
    const codes = checkClaimInvariants(bad).map((v) => v.code);
    expect(codes).toContain('I2_TERMINAL_WITHOUT_APPROVAL');
    expect(codes).toContain('I3_PARTIAL_WITHOUT_AMOUNT');
    expect(codes).toContain('I5_TERMINAL_WITH_OPEN_DEADLINE');

    const reasonOnDraft = checkClaimInvariants(
      claim({ status: 'DRAFT', terminalReasonCode: 'DEADLINE_MISSED' }),
    ).map((v) => v.code);
    expect(reasonOnDraft).toContain('I4_REASON_ON_NON_TERMINAL');
  });

  it('05 合规终局态（含批准留痕、已清 deadline）→ 无违规', () => {
    const ok = claim({
      status: 'APPROVED',
      dueAt: null,
      deadlineSource: 'UNKNOWN',
      approvedByUserId: 'user-owner',
      approvedAt: new Date('2026-09-28T00:00:00Z'),
      terminalReasonCode: 'PLATFORM_DECISION',
      respondedAt: new Date('2026-09-28T00:00:00Z'),
      responseAmount: '120.0000',
    });
    expect(checkClaimInvariants(ok)).toEqual([]);
  });

  it('06 回收确认资格：仅 APPROVED / PARTIALLY_APPROVED，且部分批准需金额', () => {
    expect(canEnterRecoveryOutcome(claim({ status: 'SUBMITTED' }))).toBe(false);
    expect(canEnterRecoveryOutcome(claim({ status: 'PARTIALLY_APPROVED', responseAmount: null }))).toBe(false);
    expect(canEnterRecoveryOutcome(claim({ status: 'PARTIALLY_APPROVED', responseAmount: '50.0000' }))).toBe(true);
    expect(canEnterRecoveryOutcome(claim({ status: 'APPROVED' }))).toBe(true);
  });

  it('07 到期清单：只列非终局且在窗口内的，按到期升序', () => {
    const items = listExpiringClaims(
      [
        claim({ id: 'c-late', dueAt: new Date('2026-09-30T00:00:00Z') }),
        claim({ id: 'c-soon', dueAt: new Date('2026-09-29T18:00:00Z') }),
        claim({ id: 'c-far', dueAt: new Date('2026-12-01T00:00:00Z') }),
        claim({ id: 'c-done', status: 'APPROVED', dueAt: new Date('2026-09-30T00:00:00Z'), approvedByUserId: 'u', approvedAt: NOW }),
      ],
      { now: NOW, withinDays: 3 },
    );
    expect(items.map((item) => item.claimId)).toEqual(['c-soon', 'c-late']);
    expect(items[0].daysLeft).toBeLessThanOrEqual(items[1].daysLeft);
  });

  it('08 投影不产出商业结论字段（不含金额判断与胜诉概率）', () => {
    const serialized = JSON.stringify(buildClaimTimeline(claim(), []));
    expect(serialized).not.toMatch(/recoverable|probability|owed|win/i);
  });
});
