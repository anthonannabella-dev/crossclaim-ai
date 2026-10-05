/** Recovery SI P2-E v1 —— 持久化入口门禁（必修 1）验收：MSG-20261005-22 */

import { describe, expect, it } from 'vitest';

import { createProductionControlPlane, type ControlPlaneConfig } from '../services/action-guard/control-plane';
import {
  P2_E_FORBIDDEN_GUARD_ACTIONS,
  P2_E_GUARD_ACTION,
  P2_E_PERSIST_GATE_BOUNDARY,
  evaluateRecoveryPersistGate,
} from '../services/intelligence/recovery-persist-gate';

const ORG = 'org-p2e';

const plane = (config: Partial<ControlPlaneConfig>) =>
  createProductionControlPlane({
    killSwitch: {
      async resolve(scope, organizationId) {
        return { scope, organizationId, value: 'enabled' as const, degraded: false };
      },
    },
    config: {
      read: () => ({
        globalDisabled: false,
        mode: 'WRITE_ENABLED',
        productionGate: 'SATISFIED',
        platformEnabled: { 'claim.prepare': true },
        tenantFeatureEnabled: { 'claim.prepare': true },
        hostApprovalGranted: true,
        ...config,
      }),
    },
  });

describe('Recovery SI P2-E v1 · 持久化入口门禁（必修 1）', () => {
  it('P2E-G1 Guard action 固定为 claim.prepare，且 claim.submit 被列为禁止', () => {
    expect(P2_E_GUARD_ACTION).toBe('claim.prepare');
    expect(P2_E_FORBIDDEN_GUARD_ACTIONS).toContain('claim.submit');
    expect(P2_E_PERSIST_GATE_BOUNDARY.requiresP2dAllow).toBe(false);
    expect(P2_E_PERSIST_GATE_BOUNDARY.transactionRequired).toBe(true);
    expect(P2_E_PERSIST_GATE_BOUNDARY.dbDeleteGuardRequired).toBe(true);
  });

  it('P2E-G2 control plane 就绪 → 以 claim.prepare 判定（不要求 P2-D claim.submit ALLOW）', async () => {
    const outcome = await evaluateRecoveryPersistGate({
      organizationId: ORG,
      actorUserId: 'user-1',
      actorOrganizationId: ORG,
      controlPlane: plane({}),
    });
    expect(outcome.guardAction).toBe('claim.prepare');
    expect(outcome.guardEvaluated).toBe(true);
    // claim.prepare 为 INTERNAL_WRITE，无需 humanApproval；在任何情况下都不等于“已持久化”
    expect(outcome.persisted).toBe(false);
    expect(outcome.transactionRequired).toBe(true);
    expect(outcome.approvalConsumed).toBe(false);
    expect(outcome.executorInvoked).toBe(false);
  });

  it('P2E-G3 actor 与目标租户不一致 → 零 Guard 调用且拒绝', async () => {
    let called = 0;
    const p = plane({});
    const spy = {
      snapshotFor: p.snapshotFor,
      async evaluateWithoutAudit(...args: Parameters<typeof p.evaluateWithoutAudit>) {
        called += 1;
        return p.evaluateWithoutAudit(...args);
      },
    };
    const outcome = await evaluateRecoveryPersistGate({
      organizationId: ORG,
      actorUserId: 'user-1',
      actorOrganizationId: 'org-other',
      controlPlane: spy,
    });
    expect(outcome.decision).toBe('DENY');
    expect(outcome.code).toBe('P2E_ACTOR_TENANT_MISMATCH');
    expect(called).toBe(0);
  });

  it('P2E-G4 control plane degraded → 零 Guard 调用且拒绝', async () => {
    const degraded = createProductionControlPlane({
      killSwitch: {
        async resolve(scope, organizationId) {
          return { scope, organizationId, value: 'enabled' as const, degraded: false };
        },
      },
      config: {
        read: () => {
          throw new Error('config source unavailable');
        },
      },
    });
    const outcome = await evaluateRecoveryPersistGate({
      organizationId: ORG,
      actorUserId: 'user-1',
      actorOrganizationId: ORG,
      controlPlane: degraded,
    });
    expect(outcome.decision).toBe('DENY');
    expect(outcome.code).toBe('P2E_CONTROL_PLANE_DEGRADED');
    expect(outcome.guardEvaluated).toBe(false);
  });

  it('P2E-G5 门禁不消费审批、不调 executor、不改写业务状态（契约字段固定）', async () => {
    const outcome = await evaluateRecoveryPersistGate({
      organizationId: ORG,
      actorUserId: 'user-1',
      actorOrganizationId: ORG,
      controlPlane: plane({}),
    });
    expect(outcome.persisted).toBe(false);
    expect(outcome.approvalConsumed).toBe(false);
    expect(outcome.executorInvoked).toBe(false);
    expect(outcome.dbDeleteGuardRequired).toBe(true);
  });
});
