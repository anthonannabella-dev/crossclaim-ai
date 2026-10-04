/** RSI Phase-1 生命周期契约验收：非法跃迁 fail-closed、Builder/Judge 隔离、OWNER gate、L4 默认关闭、证据不可变。 */

import { describe, expect, it } from 'vitest';

import {
  RSI_AUTO_PROMOTE_DEFAULT,
  RSI_OWNER_GATED_ACTIONS,
  appendEvidence,
  assertBuilderJudgeSeparation,
  canAutoPromote,
  canRsiSelfAuthorize,
  requiresOwnerApproval,
  transition,
} from '../services/autonomy/rsi-lifecycle';

describe('RSI Phase-1 生命周期', () => {
  it('RSI_LIFECYCLE_ILLEGAL_TRANSITION_FAILS_CLOSED：非法/未知跃迁一律拒绝', () => {
    // 合法路径
    expect(transition('INCIDENT', 'OPEN', 'DIAGNOSED').ok).toBe(true);
    expect(transition('TASK', 'VALIDATED', 'JUDGED').ok).toBe(true);
    expect(transition('CANDIDATE', 'POLICY_CHECKED', 'JUDGED').ok).toBe(true);

    // 跳步：未 patch 直接 test；未 validate 直接 promote
    expect(transition('CANDIDATE', 'CREATED', 'TESTED')).toEqual({
      ok: false,
      reason: 'ILLEGAL_TRANSITION',
      from: 'CREATED',
      to: 'TESTED',
    });
    expect(transition('TASK', 'READY', 'PROMOTED').ok).toBe(false);
    // 终态不可逆
    expect(transition('TASK', 'PROMOTED', 'IN_PROGRESS').ok).toBe(false);
    expect(transition('CANDIDATE', 'REJECTED', 'JUDGED').ok).toBe(false);
    // 未知状态
    expect(transition('TASK', 'NOT_A_STATE', 'READY')).toEqual({
      ok: false,
      reason: 'UNKNOWN_STATE',
      from: 'NOT_A_STATE',
      to: 'READY',
    });
  });

  it('RSI_LIFECYCLE_BUILDER_JUDGE_MUST_DIFFER：同一 actor 不得自评自批', () => {
    expect(assertBuilderJudgeSeparation('agent:builder-1', 'architect:judge-1').ok).toBe(true);
    expect(assertBuilderJudgeSeparation('agent:builder-1', 'agent:builder-1')).toEqual({
      ok: false,
      reason: 'SELF_JUDGE_FORBIDDEN',
    });
    expect(assertBuilderJudgeSeparation('', 'architect:judge-1').ok).toBe(false);
  });

  it('RSI_POLICY_OWNER_GATES_NEVER_SELF_AUTHORIZED：永久 OWNER gate 不可自我授权', () => {
    for (const action of RSI_OWNER_GATED_ACTIONS) {
      expect(requiresOwnerApproval(action)).toBe(true);
      expect(canRsiSelfAuthorize(action)).toBe(false);
    }
    // 14 项必须一个不少
    expect(RSI_OWNER_GATED_ACTIONS).toHaveLength(14);
    // 普通内部动作仍可由 RSI 执行
    expect(canRsiSelfAuthorize('CREATE_INCIDENT')).toBe(true);
    expect(canRsiSelfAuthorize('RUN_UNIT_TEST')).toBe(true);
  });

  it('RSI_POLICY_AUTO_PROMOTE_DEFAULT_OFF：L4 默认关闭，开启后也只允许 LOW', () => {
    expect(RSI_AUTO_PROMOTE_DEFAULT).toBe(false);
    expect(canAutoPromote('LOW')).toBe(false);
    expect(canAutoPromote('LOW', { autoPromoteEnabled: true })).toBe(true);
    expect(canAutoPromote('MEDIUM', { autoPromoteEnabled: true })).toBe(false);
    expect(canAutoPromote('HIGH', { autoPromoteEnabled: true })).toBe(false);
  });

  it('RSI_EVIDENCE_APPEND_ONLY：同一 evidenceId 不得改写，只允许追加', () => {
    const first = { evidenceId: 'ev-1', kind: 'TEST', digest: 'a'.repeat(64), recordedAt: '2026-10-05T00:00:00.000Z' };
    const appended = appendEvidence([], first);
    expect(appended.ok).toBe(true);
    if (!appended.ok) throw new Error('unreachable');
    expect(appended.evidence).toHaveLength(1);

    const rewrite = appendEvidence(appended.evidence, { ...first, digest: 'b'.repeat(64) });
    expect(rewrite).toEqual({ ok: false, reason: 'EVIDENCE_IMMUTABLE' });

    const second = appendEvidence(appended.evidence, { ...first, evidenceId: 'ev-2' });
    expect(second.ok).toBe(true);
  });
});
