// 状态投影 v2 单测（CHANGE A/D：显式租户 + 单一配置快照 + 零审计）

import { describe, expect, it } from 'vitest';
import { ACTION_GUARD_CATALOG } from '../services/action-guard/action-guard';
import { createProductionControlPlane, type ControlPlaneConfig } from '../services/action-guard/control-plane';
import { projectControlPlaneStatus } from '../services/action-guard/control-plane-status';

const ORG = 'b2a00000-0000-4000-8000-0000000000aa';
const ORG_B = 'b2a00000-0000-4000-8000-0000000000bb';

function buildPlane(configs: Record<string, ControlPlaneConfig | Error | undefined>) {
  const auditEvents: unknown[] = [];
  const configReads: string[] = [];
  const plane = createProductionControlPlane({
    killSwitch: {
      async resolve(scope: string) {
        return { scope, value: 'enabled' as const, degraded: false, stale: false };
      },
    },
    config: {
      read: ({ organizationId }) => {
        configReads.push(organizationId);
        const c = configs[organizationId];
        if (c instanceof Error) throw c;
        return c;
      },
    },
    audit: { write: (r) => void auditEvents.push(r) },
  });
  return { plane, auditEvents, configReads };
}

const writeEnabled = (over: Partial<ControlPlaneConfig> = {}): ControlPlaneConfig => ({
  globalDisabled: false,
  mode: 'WRITE_ENABLED',
  productionGate: 'SATISFIED',
  platformEnabled: { 'claim.submit': true },
  tenantFeatureEnabled: { 'claim.submit': true },
  hostApprovalGranted: true,
  ...over,
});

describe('Control plane status projection v2', () => {
  it('01 只读一次配置：投影所有行共享同一快照，且零审计写入', async () => {
    const { plane, auditEvents, configReads } = buildPlane({ [ORG]: writeEnabled() });
    const status = await projectControlPlaneStatus({ plane, organizationId: ORG, now: () => '2026-09-30T00:00:00.000Z' });
    expect(configReads).toEqual([ORG]); // 一次投影 = 一次配置读取
    expect(auditEvents).toHaveLength(0);
    expect(status.mode).toBe('WRITE_ENABLED');
    expect(status.configDegraded).toBe(false);
    expect(status.generatedAt).toBe('2026-09-30T00:00:00.000Z');
    expect(status.rows.map((r) => r.action)).toEqual(Object.keys(ACTION_GUARD_CATALOG).sort());
  });

  it('02 模式与判定一致：WRITE_ENABLED 快照下 claim.submit 显示 REQUIRE_APPROVAL（缺 approvalId 不冒充放行）', async () => {
    const { plane } = buildPlane({ [ORG]: writeEnabled() });
    const status = await projectControlPlaneStatus({ plane, organizationId: ORG });
    const row = status.rows.find((r) => r.action === 'claim.submit');
    expect(row?.decision).toBe('REQUIRE_APPROVAL');
    expect(row?.code).toBe('ACTION_GUARD_HUMAN_APPROVAL_REQUIRED');
    const internal = status.rows.find((r) => r.action === 'claim.prepare');
    expect(internal?.decision).toBe('DENY'); // 未开启内部 feature
  });

  it('03 显式租户：A 与 B 投影互不影响，配置读取的租户与请求一致', async () => {
    const { plane, configReads } = buildPlane({ [ORG]: writeEnabled(), [ORG_B]: { globalDisabled: false, mode: 'READ_ONLY' } });
    const a = await projectControlPlaneStatus({ plane, organizationId: ORG });
    const b = await projectControlPlaneStatus({ plane, organizationId: ORG_B });
    expect(a.mode).toBe('WRITE_ENABLED');
    expect(b.mode).toBe('READ_ONLY');
    expect(configReads).toEqual([ORG, ORG_B]);
  });

  it('04 配置源异常：如实标注 configDegraded=true 并按 READ_ONLY 展示，仍零审计', async () => {
    const { plane, auditEvents } = buildPlane({ [ORG]: new Error('config down') });
    const status = await projectControlPlaneStatus({ plane, organizationId: ORG });
    expect(status.configDegraded).toBe(true);
    expect(status.mode).toBe('READ_ONLY');
    expect(status.rows.find((r) => r.action === 'claim.submit')?.decision).toBe('DENY');
    expect(auditEvents).toHaveLength(0);
  });

  it('05 依赖缺失即失败（不返回空投影）', async () => {
    await expect(projectControlPlaneStatus({ plane: undefined as never, organizationId: ORG })).rejects.toThrow(
      'CONTROL_PLANE_STATUS_MISSING_PLANE',
    );
    const { plane } = buildPlane({});
    await expect(projectControlPlaneStatus({ plane, organizationId: '' })).rejects.toThrow(
      'CONTROL_PLANE_STATUS_MISSING_ORGANIZATION',
    );
  });
});
