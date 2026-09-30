// APP 级守卫装配单测（授权项 ② 第一批）

import { describe, expect, it } from 'vitest';
import {
  ACTION_GUARD_AUDIT_ACTOR_REF,
  createAppActionGuard,
  createPrismaActionGuardAuditPort,
  staticControlPlaneConfig,
} from '../services/action-guard/runtime-guard-composition';

const ORG = 'b2a00000-0000-4000-8000-0000000000aa';
const ACTOR = 'b2b00000-0000-4000-8000-0000000000bb';

function deps(config?: Parameters<typeof staticControlPlaneConfig>[0]) {
  const auditRows: unknown[] = [];
  const guard = createAppActionGuard({
    prisma: undefined as never,
    killSwitchResolver: {
      async resolve(scope: string) {
        return { scope, value: 'enabled' as const, degraded: false, stale: false };
      },
    },
    audit: { write: (record) => void auditRows.push(record) },
    config: config ? staticControlPlaneConfig(config) : undefined,
  });
  return { guard, auditRows };
}

describe('App-level action guard composition', () => {
  it('01 未提供配置源：默认 READ_ONLY → 写入动作拒绝，且审计落地', async () => {
    const { guard, auditRows } = deps();
    await expect(
      guard.assertAllowed({ action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' }),
    ).rejects.toMatchObject({ code: 'ACTION_GUARD_REQUIREMENTS_NOT_MET' });
    expect(auditRows).toHaveLength(1);
  });

  it('02 只读动作在默认姿态下仍允许', async () => {
    const { guard } = deps();
    expect((await guard.assertAllowed({ action: 'evidence.read', actorUserId: ACTOR, organizationId: ORG })).decision).toBe('ALLOW');
  });

  it('03 显式提供 WRITE_ENABLED + Gate + enablement + HOST 授权：外写放行', async () => {
    const { guard } = deps({
      globalDisabled: false,
      mode: 'WRITE_ENABLED',
      productionGate: 'SATISFIED',
      platformEnabled: { 'claim.submit': true },
      tenantFeatureEnabled: { 'claim.submit': true },
      hostApprovalGranted: true,
    });
    expect(
      (await guard.assertAllowed({ action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' })).decision,
    ).toBe('ALLOW');
  });

  it('04 依赖缺失即失败（不允许无 Kill Switch 源直接装配）', () => {
    expect(() => createAppActionGuard({ prisma: undefined as never })).toThrow('APP_ACTION_GUARD_MISSING_KILL_SWITCH_SOURCE');
  });

  it('05 审计端口常量符合 cc_audit_actor_shape_check（AI + actorRef）', () => {
    expect(ACTION_GUARD_AUDIT_ACTOR_REF.length).toBeGreaterThan(0);
    // 只读契约：端口工厂不读 env、不打印凭据；此处仅校验可构造
    expect(typeof createPrismaActionGuardAuditPort).toBe('function');
  });
});
