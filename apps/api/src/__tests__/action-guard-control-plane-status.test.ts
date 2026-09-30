// 控制面状态投影单测：纯评估（零审计）、只遍历目录自有键、默认 READ_ONLY 下写入全拒。

import { describe, expect, it } from 'vitest';
import { ACTION_GUARD_CATALOG } from '../services/action-guard/action-guard';
import { createProductionControlPlane, type ControlPlaneConfig } from '../services/action-guard/control-plane';
import { projectControlPlaneStatus } from '../services/action-guard/control-plane-status';

const ORG = 'b2a00000-0000-4000-8000-0000000000aa';

function buildPlane(config: Partial<ControlPlaneConfig> = {}) {
  const auditEvents: unknown[] = [];
  const plane = createProductionControlPlane({
    killSwitch: {
      async resolve(scope: string) {
        return { scope, value: 'enabled' as const, degraded: false };
      },
    },
    config: { read: () => ({ globalDisabled: false, mode: 'READ_ONLY' as const, ...config }) },
    audit: { write: (record) => void auditEvents.push(record) },
  });
  return { plane, auditEvents };
}

describe('Control plane status projection', () => {
  it('01 输出覆盖全部目录动作，且按自有键排序（无原型链泄漏）', async () => {
    const { plane } = buildPlane();
    const status = await projectControlPlaneStatus({ plane, organizationId: ORG, now: () => '2026-09-30T00:00:00.000Z' });
    expect(status.rows.map((r) => r.action)).toEqual(Object.keys(ACTION_GUARD_CATALOG).sort());
    expect(status.rows.map((r) => r.action)).not.toContain('toString');
    expect(status.generatedAt).toBe('2026-09-30T00:00:00.000Z');
    expect(status.mode).toBe('READ_ONLY');
  });

  it('02 纯评估：状态投影不产生任何审计事件', async () => {
    const { plane, auditEvents } = buildPlane();
    await projectControlPlaneStatus({ plane, organizationId: ORG });
    expect(auditEvents).toHaveLength(0);
  });

  it('03 READ_ONLY 下：写入类动作全为 DENY，只读动作 ALLOW', async () => {
    const { plane } = buildPlane();
    const status = await projectControlPlaneStatus({ plane, organizationId: ORG });
    const byAction = Object.fromEntries(status.rows.map((r) => [r.action, r]));
    expect(byAction['evidence.read'].decision).toBe('ALLOW');
    for (const action of ['claim.submit', 'platform.write', 'commission.charge', 'payment.capture', 'claim.prepare', 'billing.draft']) {
      expect(byAction[action].decision, action).toBe('DENY');
      expect(byAction[action].code, action).toBe('ACTION_GUARD_REQUIREMENTS_NOT_MET');
    }
    expect(status.summary.allow + status.summary.deny + status.summary.requireApproval).toBe(status.summary.total);
  });

  it('04 WRITE_ENABLED + 全闸门满足：外部写入在投影中显示 REQUIRE_APPROVAL（缺 approvalId，不冒充已放行）', async () => {
    const { plane } = buildPlane({
      mode: 'WRITE_ENABLED',
      platformEnabled: { 'claim.submit': true },
      tenantFeatureEnabled: { 'claim.submit': true },
      hostApprovalGranted: true,
    });
    const status = await projectControlPlaneStatus({ plane, organizationId: ORG });
    const row = status.rows.find((r) => r.action === 'claim.submit');
    expect(row?.decision).toBe('REQUIRE_APPROVAL');
    expect(row?.code).toBe('ACTION_GUARD_HUMAN_APPROVAL_REQUIRED');
  });

  it('05 依赖缺失即失败（不静默返回空投影）', async () => {
    await expect(projectControlPlaneStatus({ plane: undefined as never, organizationId: ORG })).rejects.toThrow(
      'CONTROL_PLANE_STATUS_MISSING_PLANE',
    );
    const { plane } = buildPlane();
    await expect(projectControlPlaneStatus({ plane, organizationId: '' })).rejects.toThrow(
      'CONTROL_PLANE_STATUS_MISSING_ORGANIZATION',
    );
  });
});
