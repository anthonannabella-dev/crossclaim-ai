// 控制面 v2 单测（MSG-20260930-14 CHANGE A/B/C 验收）

import { describe, expect, it } from 'vitest';
import {
  CONTROL_PLANE_DEFAULT_MODE,
  createProductionControlPlane,
  type ControlPlaneConfig,
} from '../services/action-guard/control-plane';
import { createActionGuardCapabilitySource } from '../services/action-guard/capability-source';

const ORG = 'b2a00000-0000-4000-8000-0000000000aa';
const ORG_B = 'b2a00000-0000-4000-8000-0000000000bb';
const ACTOR = 'b2b00000-0000-4000-8000-0000000000bb';

function plane(configs: Record<string, ControlPlaneConfig | Error>, ks: 'enabled' | 'disabled' = 'enabled') {
  const auditEvents: unknown[] = [];
  const seenTenants: string[] = [];
  const p = createProductionControlPlane({
    killSwitch: {
      async resolve(scope: string) {
        return { scope, value: ks, degraded: false, stale: false };
      },
    },
    config: {
      read: ({ organizationId }) => {
        seenTenants.push(organizationId);
        const c = configs[organizationId];
        if (c instanceof Error) throw c;
        return c ?? { globalDisabled: false, mode: CONTROL_PLANE_DEFAULT_MODE };
      },
    },
    audit: { write: (r) => void auditEvents.push(r) },
  });
  return { plane: p, auditEvents, seenTenants };
}

const base = (over: Partial<ControlPlaneConfig> = {}): ControlPlaneConfig => ({
  globalDisabled: false,
  mode: 'READ_ONLY',
  productionGate: 'NOT_SATISFIED',
  ...over,
});

describe('Control plane v2 — tenant context / mode / gate', () => {
  it('A1 配置读取必须收到本次调用的租户（不继承上次）', async () => {
    const { plane: p, seenTenants } = plane({
      [ORG]: base({ mode: 'WRITE_ENABLED', productionGate: 'SATISFIED' }),
      [ORG_B]: base(),
    });
    await p.guard.assertAllowed({ action: 'evidence.read', actorUserId: ACTOR, organizationId: ORG }).catch(() => undefined);
    await p.guard.assertAllowed({ action: 'evidence.read', actorUserId: ACTOR, organizationId: ORG_B }).catch(() => undefined);
    await p.snapshotFor(ORG);
    expect(seenTenants).toEqual([ORG, ORG_B, ORG]);

    // A 的配置是 WRITE_ENABLED，B 是 READ_ONLY → 两次快照必须各自独立
    expect((await p.snapshotFor(ORG)).config.mode).toBe('WRITE_ENABLED');
    expect((await p.snapshotFor(ORG_B)).config.mode).toBe('READ_ONLY');
  });

  it('A2 交替与并发调用：每次配置读取的租户与请求一致，B 不继承 A 的启用配置', async () => {
    const { plane: p, seenTenants } = plane({
      [ORG]: base({ mode: 'WRITE_ENABLED', productionGate: 'SATISFIED', platformEnabled: { 'claim.submit': true }, tenantFeatureEnabled: { 'claim.submit': true }, hostApprovalGranted: true }),
      [ORG_B]: base(),
    });
    const results = await Promise.all([
      p.snapshotFor(ORG),
      p.snapshotFor(ORG_B),
      p.snapshotFor(ORG),
      p.snapshotFor(ORG_B),
    ]);
    expect(results.map((r) => r.config.mode)).toEqual(['WRITE_ENABLED', 'READ_ONLY', 'WRITE_ENABLED', 'READ_ONLY']);
    expect(seenTenants).toEqual([ORG, ORG_B, ORG, ORG_B]);
  });

  it('B1 模式只限权：READ_ONLY + feature=true 仍拒绝内部写入', async () => {
    const { plane: p } = plane({ [ORG]: base({ mode: 'READ_ONLY', tenantFeatureEnabled: { 'claim.prepare': true }, platformEnabled: { 'claim.prepare': true } }) });
    await expect(
      p.guard.assertAllowed({ action: 'claim.prepare', actorUserId: ACTOR, organizationId: ORG }),
    ).rejects.toMatchObject({ code: 'ACTION_GUARD_REQUIREMENTS_NOT_MET' });
  });

  it('B2 MANUAL_REVIEW + feature=false 仍拒绝内部写入；feature=true 才放行', async () => {
    const { plane: p } = plane({
      [ORG]: base({ mode: 'MANUAL_REVIEW', tenantFeatureEnabled: { 'claim.prepare': false, 'billing.draft': true } }),
    });
    await expect(
      p.guard.assertAllowed({ action: 'claim.prepare', actorUserId: ACTOR, organizationId: ORG }),
    ).rejects.toMatchObject({ code: 'ACTION_GUARD_REQUIREMENTS_NOT_MET' });
    expect((await p.guard.assertAllowed({ action: 'billing.draft', actorUserId: ACTOR, organizationId: ORG })).decision).toBe('ALLOW');
  });

  it('B3 四模式 × 内部写入（claim.prepare/billing.draft）许可矩阵', async () => {
    const expectations: Record<string, boolean> = {
      READ_ONLY: false,
      DRY_RUN: false,
      MANUAL_REVIEW: true,
      WRITE_ENABLED: true,
    };
    for (const [mode, allowed] of Object.entries(expectations)) {
      const { plane: p } = plane({
        [ORG]: base({
          mode: mode as ControlPlaneConfig['mode'],
          productionGate: 'SATISFIED',
          tenantFeatureEnabled: { 'claim.prepare': true, 'billing.draft': true },
        }),
      });
      for (const action of ['claim.prepare', 'billing.draft']) {
        const result = await p.evaluateWithoutAudit({ action, actorUserId: ACTOR, organizationId: ORG });
        expect(result.decision, `${mode}/${action}`).toBe(allowed ? 'ALLOW' : 'DENY');
      }
    }
  });

  it('B4 Kill Switch disabled：任何模式下的内部写入都拒绝', async () => {
    const { plane: p } = plane(
      { [ORG]: base({ mode: 'WRITE_ENABLED', productionGate: 'SATISFIED', tenantFeatureEnabled: { 'claim.prepare': true } }) },
      'disabled',
    );
    await expect(
      p.guard.assertAllowed({ action: 'claim.prepare', actorUserId: ACTOR, organizationId: ORG }),
    ).rejects.toMatchObject({ code: 'ACTION_GUARD_REQUIREMENTS_NOT_MET' });
  });

  it('C1 Production Gate 独立：WRITE_ENABLED + 全 enablement + 审批，但 Gate 缺失/UNKNOWN/NOT_SATISFIED → DENY', async () => {
    for (const gate of [undefined, 'UNKNOWN', 'NOT_SATISFIED'] as const) {
      const { plane: p } = plane({
        [ORG]: base({
          mode: 'WRITE_ENABLED',
          productionGate: gate,
          platformEnabled: { 'claim.submit': true },
          tenantFeatureEnabled: { 'claim.submit': true },
          hostApprovalGranted: true,
        }),
      });
      await expect(
        p.guard.assertAllowed({ action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' }),
      ).rejects.toMatchObject({ code: 'ACTION_GUARD_REQUIREMENTS_NOT_MET' });
    }
  });

  it('C2 Gate=SATISFIED + 其余条件满足：进入审批判断（缺 approvalId → REQUIRE_APPROVAL；有则 ALLOW）', async () => {
    const { plane: p } = plane({
      [ORG]: base({
        mode: 'WRITE_ENABLED',
        productionGate: 'SATISFIED',
        platformEnabled: { 'claim.submit': true },
        tenantFeatureEnabled: { 'claim.submit': true },
        hostApprovalGranted: true,
      }),
    });
    await expect(
      p.guard.assertAllowed({ action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG }),
    ).rejects.toMatchObject({ code: 'ACTION_GUARD_HUMAN_APPROVAL_REQUIRED' });
    expect(
      (await p.guard.assertAllowed({ action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' })).decision,
    ).toBe('ALLOW');
  });

  it('C3 secret.rotate：READ_ONLY / DRY_RUN 拒绝；MANUAL_REVIEW 起且需 HOST 授权 + 显式 feature', async () => {
    const modes: Array<[ControlPlaneConfig['mode'], boolean]> = [
      ['READ_ONLY', false],
      ['DRY_RUN', false],
      ['MANUAL_REVIEW', true],
      ['WRITE_ENABLED', true],
    ];
    for (const [mode, allowed] of modes) {
      const { plane: p } = plane({
        [ORG]: base({ mode, productionGate: 'SATISFIED', tenantFeatureEnabled: { 'secret.rotate': true }, hostApprovalGranted: true }),
      });
      const result = await p.evaluateWithoutAudit({ action: 'secret.rotate', actorUserId: ACTOR, organizationId: ORG });
      expect(result.decision, mode).toBe(allowed ? 'ALLOW' : 'DENY');
    }
    // HOST 授权缺失 → 拒绝
    const { plane: p2 } = plane({
      [ORG]: base({ mode: 'WRITE_ENABLED', tenantFeatureEnabled: { 'secret.rotate': true }, hostApprovalGranted: false }),
    });
    await expect(
      p2.guard.assertAllowed({ action: 'secret.rotate', actorUserId: ACTOR, organizationId: ORG }),
    ).rejects.toMatchObject({ code: 'ACTION_GUARD_REQUIREMENTS_NOT_MET' });
  });

  it('C4 globalDisabled：压制所有非只读动作，只读仍允许', async () => {
    const { plane: p } = plane({
      [ORG]: base({
        globalDisabled: true,
        mode: 'WRITE_ENABLED',
        productionGate: 'SATISFIED',
        platformEnabled: { 'claim.submit': true, 'claim.prepare': true },
        tenantFeatureEnabled: { 'claim.submit': true, 'claim.prepare': true, 'secret.rotate': true },
        hostApprovalGranted: true,
      }),
    });
    for (const action of ['claim.submit', 'claim.prepare', 'billing.draft', 'secret.rotate']) {
      await expect(
        p.guard.assertAllowed({ action, actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' }),
      ).rejects.toMatchObject({ code: 'ACTION_GUARD_REQUIREMENTS_NOT_MET' });
    }
    expect((await p.guard.assertAllowed({ action: 'evidence.read', actorUserId: ACTOR, organizationId: ORG })).decision).toBe('ALLOW');
  });

  it('A3 配置源异常：该租户回落 READ_ONLY 且标记 degraded（不继承其它租户）', async () => {
    const { plane: p } = plane({
      [ORG]: base({ mode: 'WRITE_ENABLED', productionGate: 'SATISFIED' }),
      [ORG_B]: new Error('config down'),
    });
    const a = await p.snapshotFor(ORG);
    const b = await p.snapshotFor(ORG_B);
    expect(a.config.mode).toBe('WRITE_ENABLED');
    expect(a.degraded).toBe(false);
    expect(b.config.mode).toBe('READ_ONLY');
    expect(b.degraded).toBe(true);
  });
});

// 保留一个对 capability source 的直接断言，确保 stale/degraded 由上层拒绝（CHANGE D 协同）
describe('capability source + stale/degraded', () => {
  it('stale enabled 视为未启用（来自 Kill Switch 的陈旧值不得放行）', async () => {
    const source = createActionGuardCapabilitySource({
      killSwitch: {
        async resolve(scope: string) {
          return { scope, value: 'enabled', degraded: false, stale: true };
        },
      },
    });
    const snapshot = await source.resolve({ organizationId: ORG, action: 'claim.submit' });
    expect(snapshot?.tenantEnabled).toBe(false);
  });
});
