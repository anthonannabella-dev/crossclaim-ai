// PRODUCTION CONTROL PLANE 单测（MSG-20260930-03 项 ③）：默认 read-only、模式分层、全局熔断优先。

import { describe, expect, it } from 'vitest';
import {
  CONTROL_PLANE_DEFAULT_MODE,
  createProductionControlPlane,
  type ControlPlaneConfig,
} from '../services/action-guard/control-plane';

const ORG = 'b2a00000-0000-4000-8000-0000000000aa';
const ACTOR = 'b2b00000-0000-4000-8000-0000000000bb';

function plane(config: Partial<ControlPlaneConfig>, killSwitchValue: 'enabled' | 'disabled' = 'enabled') {
  return createProductionControlPlane({
    killSwitch: {
      async resolve(scope: string) {
        return { scope, value: killSwitchValue, degraded: false };
      },
    },
    config: { read: () => ({ globalDisabled: false, mode: CONTROL_PLANE_DEFAULT_MODE, ...config }) },
    audit: { write: () => {} },
  });
}

describe('Production Control Plane', () => {
  it('01 默认模式 = READ_ONLY，且默认拒绝一切写入动作', async () => {
    const cp = plane({});
    expect((await cp.snapshot()).mode).toBe('READ_ONLY');

    for (const action of ['claim.submit', 'platform.write', 'commission.charge', 'claim.prepare', 'billing.draft']) {
      const error = (await cp.guard
        .assertAllowed({ action, actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' })
        .catch((e) => e)) as { code?: string };
      expect(error.code, action).toBe('ACTION_GUARD_REQUIREMENTS_NOT_MET');
    }
    // 只读动作仍可评估为 ALLOW（不涉写入）
    const read = await cp.guard.assertAllowed({ action: 'evidence.read', actorUserId: ACTOR, organizationId: ORG });
    expect(read.decision).toBe('ALLOW');
  });

  it('02 DRY_RUN：仍不放行外部写入与资金动作', async () => {
    const cp = plane({ mode: 'DRY_RUN', platformEnabled: { 'claim.submit': true }, tenantFeatureEnabled: { 'claim.submit': true } });
    await expect(
      cp.guard.assertAllowed({ action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' }),
    ).rejects.toMatchObject({ code: 'ACTION_GUARD_REQUIREMENTS_NOT_MET' });
  });

  it('03 MANUAL_REVIEW：允许内部写入，但仍不放行外部写入', async () => {
    const cp = plane({
      mode: 'MANUAL_REVIEW',
      platformEnabled: { 'claim.prepare': true, 'claim.submit': true },
      tenantFeatureEnabled: { 'claim.prepare': true, 'claim.submit': true },
    });
    const internal = await cp.guard.assertAllowed({ action: 'claim.prepare', actorUserId: ACTOR, organizationId: ORG });
    expect(internal.decision).toBe('ALLOW');
    await expect(
      cp.guard.assertAllowed({ action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' }),
    ).rejects.toMatchObject({ code: 'ACTION_GUARD_REQUIREMENTS_NOT_MET' });
  });

  it('04 WRITE_ENABLED + Kill Switch 开启 + 平台/租户 enablement + 审批：外部写入才 ALLOW', async () => {
    const cp = plane({
      mode: 'WRITE_ENABLED',
      platformEnabled: { 'claim.submit': true },
      tenantFeatureEnabled: { 'claim.submit': true },
      hostApprovalGranted: true,
    });
    const allowed = await cp.guard.assertAllowed({
      action: 'claim.submit',
      actorUserId: ACTOR,
      organizationId: ORG,
      approvalId: 'a-1',
    });
    expect(allowed.decision).toBe('ALLOW');
  });

  it('05 缺少租户 enablement：即使 WRITE_ENABLED 也拒绝', async () => {
    const cp = plane({ mode: 'WRITE_ENABLED', platformEnabled: { 'claim.submit': true }, hostApprovalGranted: true });
    await expect(
      cp.guard.assertAllowed({ action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' }),
    ).rejects.toMatchObject({ code: 'ACTION_GUARD_REQUIREMENTS_NOT_MET' });
  });

  it('06 全局熔断优先：globalDisabled=true 时任何模式都不放行', async () => {
    const cp = plane({
      globalDisabled: true,
      mode: 'WRITE_ENABLED',
      platformEnabled: { 'claim.submit': true, 'claim.prepare': true },
      tenantFeatureEnabled: { 'claim.submit': true, 'claim.prepare': true },
      hostApprovalGranted: true,
    });
    for (const action of ['claim.submit', 'claim.prepare']) {
      await expect(
        cp.guard.assertAllowed({ action, actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' }),
      ).rejects.toMatchObject({ code: 'ACTION_GUARD_REQUIREMENTS_NOT_MET' });
    }
  });

  it('07 Kill Switch disabled：即使 WRITE_ENABLED 也拒绝（逐层 fail closed）', async () => {
    const cp = plane(
      {
        mode: 'WRITE_ENABLED',
        platformEnabled: { 'claim.submit': true },
        tenantFeatureEnabled: { 'claim.submit': true },
        hostApprovalGranted: true,
      },
      'disabled',
    );
    await expect(
      cp.guard.assertAllowed({ action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' }),
    ).rejects.toMatchObject({ code: 'ACTION_GUARD_REQUIREMENTS_NOT_MET' });
  });

  it('08 未知动作在控制面下仍是 UNKNOWN_ACTION（自有键检查贯穿）', async () => {
    const cp = plane({ mode: 'WRITE_ENABLED' });
    for (const action of ['toString', 'not.registered']) {
      await expect(
        cp.guard.assertAllowed({ action, actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' }),
      ).rejects.toMatchObject({ code: 'ACTION_GUARD_UNKNOWN_ACTION' });
    }
  });
});
