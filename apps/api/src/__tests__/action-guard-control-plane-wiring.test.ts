// wiring v2 单测（CHANGE A：无共享租户状态）

import { describe, expect, it } from 'vitest';
import { createWiredControlPlane } from '../services/action-guard/control-plane-wiring';
import type { ControlPlaneConfig } from '../services/action-guard/control-plane';

const ORG = 'b2a00000-0000-4000-8000-0000000000aa';
const ORG_B = 'b2a00000-0000-4000-8000-0000000000bb';
const ACTOR = 'b2b00000-0000-4000-8000-0000000000bb';

function wiring(configs: Record<string, ControlPlaneConfig | undefined>, opts: { auditThrows?: boolean; ks?: 'enabled' | 'disabled' } = {}) {
  const seen: string[] = [];
  const events: unknown[] = [];
  const plane = createWiredControlPlane({
    killSwitch: {
      async resolve(scope: string) {
        return { scope, value: opts.ks ?? 'enabled', degraded: false, stale: false };
      },
    },
    audit: {
      write(record) {
        if (opts.auditThrows) throw new Error('audit sink down');
        events.push(record);
      },
    },
    config: {
      read: ({ organizationId }) => {
        seen.push(organizationId);
        return configs[organizationId];
      },
    },
  });
  return { plane, seen, events };
}

const ready = (over: Partial<ControlPlaneConfig> = {}): ControlPlaneConfig => ({
  globalDisabled: false,
  mode: 'WRITE_ENABLED',
  productionGate: 'SATISFIED',
  platformEnabled: { 'claim.submit': true },
  tenantFeatureEnabled: { 'claim.submit': true },
  hostApprovalGranted: true,
  ...over,
});

describe('Control plane wiring v2', () => {
  it('01 未提供配置端口：READ_ONLY + 写入动作全拒', async () => {
    const plane = createWiredControlPlane({
      killSwitch: { async resolve(scope: string) { return { scope, value: 'enabled' as const, degraded: false }; } },
      audit: { write: () => {} },
    });
    expect((await plane.snapshotFor(ORG)).config.mode).toBe('READ_ONLY');
    await expect(
      plane.guard.assertAllowed({ action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' }),
    ).rejects.toMatchObject({ code: 'ACTION_GUARD_REQUIREMENTS_NOT_MET' });
  });

  it('02 全闸门满足（含独立 Gate）：ALLOW 并写审计', async () => {
    const { plane, events } = wiring({ [ORG]: ready() });
    const result = await plane.guard.assertAllowed({ action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' });
    expect(result.decision).toBe('ALLOW');
    expect(events).toHaveLength(1);
  });

  it('03 审计写入失败：ALLOW 降级为 DENY', async () => {
    const { plane } = wiring({ [ORG]: ready() }, { auditThrows: true });
    await expect(
      plane.guard.assertAllowed({ action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' }),
    ).rejects.toMatchObject({ code: 'ACTION_GUARD_AUDIT_UNAVAILABLE' });
  });

  it('04 两租户配置互不继承：A 放行、B（未配置 → READ_ONLY）拒绝，且配置读取租户与请求一致', async () => {
    const { plane, seen } = wiring({ [ORG]: ready(), [ORG_B]: undefined });
    expect((await plane.guard.assertAllowed({ action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' })).decision).toBe('ALLOW');
    await expect(
      plane.guard.assertAllowed({ action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG_B, approvalId: 'a-1' }),
    ).rejects.toMatchObject({ code: 'ACTION_GUARD_REQUIREMENTS_NOT_MET' });
    expect(seen).toEqual([ORG, ORG_B]);
  });

  it('05 只读动作不受模式与 Gate 影响', async () => {
    const { plane } = wiring({ [ORG]: { globalDisabled: false, mode: 'READ_ONLY' } });
    expect((await plane.guard.assertAllowed({ action: 'evidence.read', actorUserId: ACTOR, organizationId: ORG })).decision).toBe('ALLOW');
  });
});
