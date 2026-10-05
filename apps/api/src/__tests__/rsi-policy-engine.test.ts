/** RSI-P1-06 验收：L0–L5 分级、永久 OWNER 硬禁、Kill Switch、未知动作 fail-closed */

import { describe, expect, it } from 'vitest';

import {
  RSI_ACTION_POLICY,
  RSI_PERMANENTLY_FORBIDDEN_ACTIONS,
  RSI_POLICY_ENGINE_BOUNDARY,
  RSI_POLICY_LEVELS,
  decideRsiPolicyAction,
} from '../services/autonomy/rsi-policy-engine';
import { RSI_DEFAULT_FLAGS } from '../services/autonomy/rsi-runtime-config';

const flags = (over: Partial<typeof RSI_DEFAULT_FLAGS> = {}) => ({ ...RSI_DEFAULT_FLAGS, ...over });

describe('RSI policy engine', () => {
  it('RSI_POLICY_DEFAULT_ALLOWS_REGISTERED_WORK：默认 flags 下已登记的内部动作放行', () => {
    expect(decideRsiPolicyAction({ action: 'OBSERVE_STATE' }).allowedForRsi).toBe(true);
    expect(decideRsiPolicyAction({ action: 'GENERATE_INCIDENT' }).allowedForRsi).toBe(true);
    expect(decideRsiPolicyAction({ action: 'PROPOSE_PATCH' }).allowedForRsi).toBe(true);
    expect(decideRsiPolicyAction({ action: 'JUDGE_CANDIDATE' }).allowedForRsi).toBe(true);
    expect(decideRsiPolicyAction({ action: 'JUDGE_CANDIDATE' }).reasonCodes).toEqual(['ALLOWED']);
  });

  it('RSI_POLICY_L5_PERMANENTLY_FORBIDDEN：特权动作永远不允许 RSI 执行，带 OWNER 批准也不放宽', () => {
    for (const action of ['EXTERNAL_WRITE', 'PAYMENT', 'TRANSPORT', 'PRODUCTION_CREDENTIALS', 'DISABLE_KILL_SWITCH']) {
      const withApproval = decideRsiPolicyAction({ action, ownerApprovalRef: 'owner-approval-1' });
      expect(withApproval.allowedForRsi).toBe(false);
      expect(withApproval.permanentlyForbidden).toBe(true);
      expect(withApproval.requiresOwnerApproval).toBe(true);
      expect(withApproval.reasonCodes).toContain('PERMANENTLY_FORBIDDEN_FOR_RSI');
      expect(withApproval.reasonCodes).toContain('OWNER_APPROVAL_REQUIRED');
    }
    expect(RSI_PERMANENTLY_FORBIDDEN_ACTIONS).toContain('EXTERNAL_WRITE');
    expect(RSI_PERMANENTLY_FORBIDDEN_ACTIONS).toContain('CUSTOMS_FILING');
    expect(RSI_PERMANENTLY_FORBIDDEN_ACTIONS).toContain('RAISE_OWN_PRIVILEGE');
  });

  it('RSI_POLICY_KILL_SWITCH_BLOCKS_NEW_WORK：Kill Switch 触发 → 新工作拒绝，只读动作仍允许', () => {
    const paused = flags({ paused: true });
    const newWork = decideRsiPolicyAction({ action: 'GENERATE_INCIDENT' }, { flags: paused });
    expect(newWork.allowedForRsi).toBe(false);
    expect(newWork.reasonCodes).toEqual(['KILL_SWITCH_PAUSED']);

    const patch = decideRsiPolicyAction({ action: 'PROPOSE_PATCH' }, { flags: paused });
    expect(patch.allowedForRsi).toBe(false);
    expect(patch.reasonCodes).toEqual(['KILL_SWITCH_PAUSED']);

    const readOnly = decideRsiPolicyAction({ action: 'OBSERVE_STATE' }, { flags: paused });
    expect(readOnly.allowedForRsi).toBe(true);
    expect(readOnly.reasonCodes).toEqual(['ALLOWED', 'PAUSED_READ_ONLY_ALLOWED']);
  });

  it('RSI_POLICY_DISABLED_RSI_BLOCKS_EVERYTHING：总开关关闭 → 连只读动作也拒绝', () => {
    const disabled = flags({ enabled: false });
    const readOnly = decideRsiPolicyAction({ action: 'OBSERVE_STATE' }, { flags: disabled });
    expect(readOnly.allowedForRsi).toBe(false);
    expect(readOnly.reasonCodes).toEqual(['RSI_DISABLED']);
    expect(decideRsiPolicyAction({ action: 'PROPOSE_PATCH' }, { flags: disabled }).allowedForRsi).toBe(false);
  });

  it('RSI_POLICY_STAGE_GATE：对应 stage 关闭 → 该层级动作拒绝（STAGE_DISABLED）', () => {
    const noPatch = { ...RSI_DEFAULT_FLAGS, stages: { ...RSI_DEFAULT_FLAGS.stages, AUTO_PATCH: false } };
    const decision = decideRsiPolicyAction({ action: 'PROPOSE_PATCH' }, { flags: noPatch });
    expect(decision.allowedForRsi).toBe(false);
    expect(decision.reasonCodes).toEqual(['STAGE_DISABLED:AUTO_PATCH']);
    expect(decision.level).toBe('L3');
  });

  it('RSI_POLICY_AUTO_PROMOTE_DEFAULT_OFF：L4 提升默认拒绝；仅显式开启且 LOW 风险才放行', () => {
    const off = decideRsiPolicyAction({ action: 'PROMOTE_LOW_RISK', riskClass: 'LOW' });
    expect(off.allowedForRsi).toBe(false);
    expect(off.requiresOwnerApproval).toBe(true);
    expect(off.reasonCodes).toContain('AUTO_PROMOTE_DISABLED');
    expect(off.reasonCodes).toContain('AUTO_PROMOTE_LOW_RISK_ONLY');

    // 显式开启也必须同时打开 stage 开关；两者都满足 + 低风险才放行
    const promotionFlags = {
      ...RSI_DEFAULT_FLAGS,
      stages: { ...RSI_DEFAULT_FLAGS.stages, AUTO_PROMOTE_LOW_RISK: true },
    };
    const stageOnOnly = decideRsiPolicyAction({ action: 'PROMOTE_LOW_RISK', riskClass: 'LOW' }, { flags: promotionFlags });
    expect(stageOnOnly.allowedForRsi).toBe(false);
    expect(stageOnOnly.reasonCodes).toContain('AUTO_PROMOTE_DISABLED');

    const onLow = decideRsiPolicyAction(
      { action: 'PROMOTE_LOW_RISK', riskClass: 'LOW' },
      { flags: promotionFlags, autoPromoteEnabled: true },
    );
    expect(onLow.allowedForRsi).toBe(true);

    const onHigh = decideRsiPolicyAction(
      { action: 'PROMOTE_LOW_RISK', riskClass: 'HIGH' },
      { flags: promotionFlags, autoPromoteEnabled: true },
    );
    expect(onHigh.allowedForRsi).toBe(false);
    expect(onHigh.reasonCodes).toContain('AUTO_PROMOTE_LOW_RISK_ONLY');
  });

  it('RSI_POLICY_UNKNOWN_ACTION_FAILS_CLOSED：未登记动作按最严处理', () => {
    const decision = decideRsiPolicyAction({ action: 'SOMETHING_NOT_REGISTERED' });
    expect(decision.allowedForRsi).toBe(false);
    expect(decision.permanentlyForbidden).toBe(true);
    expect(decision.requiresOwnerApproval).toBe(true);
    expect(decision.reasonCodes).toEqual(['PERMANENTLY_FORBIDDEN_FOR_RSI', 'UNKNOWN_ACTION_FAIL_CLOSED']);
  });

  it('RSI_POLICY_LEVELS_COVER_ALL_ACTIONS：层级取值合法，且只有 L5 是永久禁区', () => {
    for (const [action, policy] of Object.entries(RSI_ACTION_POLICY)) {
      expect(RSI_POLICY_LEVELS).toContain(policy.level);
      const decision = decideRsiPolicyAction({ action });
      expect(decision.permanentlyForbidden).toBe(policy.level === 'L5');
    }
    expect(RSI_ACTION_POLICY.OBSERVE_STATE?.level).toBe('L0');
    expect(RSI_ACTION_POLICY.JUDGE_CANDIDATE?.level).toBe('L4');
    expect(RSI_ACTION_POLICY.EXTERNAL_WRITE?.level).toBe('L5');
  });

  it('RSI_POLICY_DECISION_IS_DETERMINISTIC：同一输入多次调用结果一致', () => {
    const first = decideRsiPolicyAction({ action: 'PROPOSE_PATCH' });
    const second = decideRsiPolicyAction({ action: 'PROPOSE_PATCH' });
    expect(second).toEqual(first);
  });

  it('RSI_POLICY_ENGINE_BOUNDARY：不授予新权限、不执行动作、不落库、不发网络', () => {
    expect(RSI_POLICY_ENGINE_BOUNDARY.grantsNewAuthority).toBe(false);
    expect(RSI_POLICY_ENGINE_BOUNDARY.unknownActionFailsClosed).toBe(true);
    expect(RSI_POLICY_ENGINE_BOUNDARY.ownerApprovalDoesNotUnlockL5).toBe(true);
    expect(RSI_POLICY_ENGINE_BOUNDARY.executesActions).toBe(false);
    expect(RSI_POLICY_ENGINE_BOUNDARY.writesDatabase).toBe(false);
    expect(RSI_POLICY_ENGINE_BOUNDARY.performsNetworkCalls).toBe(false);
    expect(RSI_POLICY_ENGINE_BOUNDARY.readsCredentials).toBe(false);
  });
});
