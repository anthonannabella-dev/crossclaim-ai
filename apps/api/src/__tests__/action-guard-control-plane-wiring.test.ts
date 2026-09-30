// CONTROL PLANE WIRING 单测：真实依赖组合 + 缺省 READ_ONLY + 配置读取失败 fail closed

import { describe, expect, it } from 'vitest';
import { createWiredControlPlane } from '../services/action-guard/control-plane-wiring';
import type { ControlPlaneConfig } from '../services/action-guard/control-plane';

const ORG = 'b2a00000-0000-4000-8000-0000000000aa';
const ACTOR = 'b2b00000-0000-4000-8000-0000000000bb';

function wiring(config?: unknown, opts: { killSwitch?: 'enabled' | 'disabled'; auditThrows?: boolean; configThrows?: boolean } = {}) {
  const events: unknown[] = [];
  const plane = createWiredControlPlane({
    killSwitch: {
      async resolve(scope: string) {
        return { scope, value: opts.killSwitch ?? 'enabled', degraded: false };
      },
    },
    audit: {
      write(record) {
        if (opts.auditThrows) throw new Error('audit sink down');
        events.push(record);
      },
    },
    config: {
      read: () => {
        if (opts.configThrows) throw new Error('config source down');
        return config as ControlPlaneConfig | undefined;
      },
    },
  });
  return { plane, events };
}

describe('Control plane wiring', () => {
  it('01 未提供配置端口：一律 READ_ONLY，写入动作全拒', async () => {
    const { plane } = wiring(undefined);
    expect((await plane.currentConfig()).mode).toBe('READ_ONLY');
    await expect(
      plane.guard.assertAllowed({ action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' }),
    ).rejects.toMatchObject({ code: 'ACTION_GUARD_REQUIREMENTS_NOT_MET' });
  });

  it('02 配置读取抛异常：fail closed 回落 READ_ONLY（不沿用旧配置）', async () => {
    const { plane } = wiring({ mode: 'WRITE_ENABLED' }, { configThrows: true });
    expect((await plane.currentConfig()).mode).toBe('READ_ONLY');
    await expect(
      plane.guard.assertAllowed({ action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' }),
    ).rejects.toMatchObject({ code: 'ACTION_GUARD_REQUIREMENTS_NOT_MET' });
  });

  it('03 显式 WRITE_ENABLED + Kill Switch 开启 + 平台/租户 enablement：外部写入放行并写审计', async () => {
    const { plane, events } = wiring({
      globalDisabled: false,
      mode: 'WRITE_ENABLED',
      platformEnabled: { 'claim.submit': true },
      tenantFeatureEnabled: { 'claim.submit': true },
      hostApprovalGranted: true,
    });
    const result = await plane.guard.assertAllowed({
      action: 'claim.submit',
      actorUserId: ACTOR,
      organizationId: ORG,
      approvalId: 'a-1',
    });
    expect(result.decision).toBe('ALLOW');
    expect(events).toHaveLength(1);
  });

  it('04 审计写入失败：ALLOW 降级为 DENY（不可审计的动作不执行）', async () => {
    const { plane } = wiring(
      {
        globalDisabled: false,
        mode: 'WRITE_ENABLED',
        platformEnabled: { 'claim.submit': true },
        tenantFeatureEnabled: { 'claim.submit': true },
        hostApprovalGranted: true,
      },
      { auditThrows: true },
    );
    await expect(
      plane.guard.assertAllowed({ action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' }),
    ).rejects.toMatchObject({ code: 'ACTION_GUARD_AUDIT_UNAVAILABLE' });
  });

  it('05 全局熔断：即使配置 WRITE_ENABLED 也拒绝', async () => {
    const { plane } = wiring({
      globalDisabled: true,
      mode: 'WRITE_ENABLED',
      platformEnabled: { 'claim.submit': true },
      tenantFeatureEnabled: { 'claim.submit': true },
      hostApprovalGranted: true,
    });
    await expect(
      plane.guard.assertAllowed({ action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' }),
    ).rejects.toMatchObject({ code: 'ACTION_GUARD_REQUIREMENTS_NOT_MET' });
  });

  it('06 只读动作不受模式影响（READ_ONLY 下仍可评估为 ALLOW）', async () => {
    const { plane } = wiring(undefined);
    const read = await plane.guard.assertAllowed({ action: 'evidence.read', actorUserId: ACTOR, organizationId: ORG });
    expect(read.decision).toBe('ALLOW');
  });
});
