/** Recovery SI P2-E v1 —— 持久化入口门禁（必修 1）验收：MSG-20261005-22 */

import { describe, expect, it } from 'vitest';

import { createProductionControlPlane, type ControlPlaneConfig } from '../services/action-guard/control-plane';
import {
  P2_E_FORBIDDEN_GUARD_ACTIONS,
  P2_E_GUARD_ACTION,
  P2_E_PERSIST_GATE_BOUNDARY,
  evaluateRecoveryPersistGate,
  RECOVERY_PACKAGE_DELETE_GUARD,
  RECOVERY_PERSIST_LINEAGE,
  RECOVERY_PERSIST_TRANSACTION_FAILURE_POLICY,
  RECOVERY_PERSIST_TRANSACTION_UNITS,
  persistRecoveryPackageWithinTransaction,
  buildRecoveryPackageLineageProjection,
  type RecoveryPersistGateOutcome,
  type RecoveryPersistUnitWrite,
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


describe('Recovery SI P2-E v1 · 事务 / lineage / DELETE guard 契约（必修 2/3/4）', () => {
  it('P2E-G6 事务单元集合固定，失败策略为整体回滚', () => {
    expect(RECOVERY_PERSIST_TRANSACTION_UNITS).toEqual([
      'RecoveryPackage',
      'RecoveryPackageArtifact',
      'FileAsset',
      'AuditLog',
    ]);
    expect(RECOVERY_PERSIST_TRANSACTION_FAILURE_POLICY).toBe('ROLLBACK_ALL');
  });

  it('P2E-G7 lineage：planDigest 仅追溯 basis，业务身份仍是 packageDigest', () => {
    expect(RECOVERY_PERSIST_LINEAGE.businessIdentity).toBe('packageDigest');
    expect(RECOVERY_PERSIST_LINEAGE.traceBasis).toBe('planDigest');
    expect(RECOVERY_PERSIST_LINEAGE.planDigestReplacesPackageDigest).toBe(false);
    expect(RECOVERY_PERSIST_LINEAGE.evidenceRefs).toContain('RecoveryPlan');
  });

  it('P2E-G8 DELETE guard：应用层禁止删除，DB 触发器必填且清单需同步（迁移已应用）', () => {
    expect(RECOVERY_PACKAGE_DELETE_GUARD.applicationDeleteAllowed).toBe(false);
    expect(RECOVERY_PACKAGE_DELETE_GUARD.dbTriggerRequired).toBe(true);
    expect(RECOVERY_PACKAGE_DELETE_GUARD.triggerManifestSyncRequired).toBe(true);
    expect(RECOVERY_PACKAGE_DELETE_GUARD.migrationStatus).toBe('APPLIED');
  });
});


describe('Recovery SI P2-E v1 · 单一事务端口（P2-E2 必修 2）', () => {
  const units = () =>
    RECOVERY_PERSIST_TRANSACTION_UNITS.map((unit) => ({ unit, payload: { digest: 'd-' + unit } }));

  const gateAllow = (over: Partial<RecoveryPersistGateOutcome> = {}): RecoveryPersistGateOutcome => ({
    decision: 'ALLOW',
    code: 'ALLOW',
    reasons: [],
    guardAction: 'claim.prepare',
    guardEvaluated: true,
    persisted: false,
    transactionRequired: true,
    dbDeleteGuardRequired: true,
    approvalConsumed: false,
    executorInvoked: false,
    ...over,
  });

  it('P2E-G9 门禁非 ALLOW → 端口零调用、不持久化', async () => {
    let calls = 0;
    const port = { async runInTransaction() { calls += 1; } };
    const r = await persistRecoveryPackageWithinTransaction({
      gate: gateAllow({ decision: 'REQUIRES_APPROVAL' }),
      units: units(),
      port,
    });
    expect(calls).toBe(0);
    expect(r.persisted).toBe(false);
    expect(r.code).toBe('P2E_GATE_NOT_ALLOWED');
    expect(r.unitsWritten).toBe(0);
  });

  it('P2E-G10 单元集合不符 → fail-closed（端口零调用）', async () => {
    let calls = 0;
    const port = { async runInTransaction() { calls += 1; } };
    await expect(
      persistRecoveryPackageWithinTransaction({
        gate: gateAllow(),
        units: units().slice(0, 3),
        port,
      }),
    ).rejects.toThrow(/P2E_TRANSACTION_UNIT_SET_MISMATCH/);
    expect(calls).toBe(0);
  });

  it('P2E-G11 成功路径：整批交给同一事务端口一次，返回 lineage 语义', async () => {
    const seen: string[] = [];
    const port = { async runInTransaction(u: readonly RecoveryPersistUnitWrite[]) { seen.push(u.map((x) => x.unit).sort().join(",")); } };
    const r = await persistRecoveryPackageWithinTransaction({ gate: gateAllow(), units: units(), port });
    expect(seen).toEqual(['AuditLog,FileAsset,RecoveryPackage,RecoveryPackageArtifact']);
    expect(r.persisted).toBe(true);
    expect(r.unitsWritten).toBe(4);
    expect(r.businessIdentity).toBe('packageDigest');
    expect(r.traceBasis).toBe('planDigest');
  });

  it('P2E-G12 端口抛错 → 错误上抛（不吞异常、不返回 persisted）', async () => {
    const port = { async runInTransaction() { throw new Error('DB_ROLLBACK'); } };
    await expect(
      persistRecoveryPackageWithinTransaction({ gate: gateAllow(), units: units(), port }),
    ).rejects.toThrow(/DB_ROLLBACK/);
  });
});


describe('Recovery SI P2-E v1 · lineage 反查投影（P2-E3 必修 3）', () => {
  const base = () => ({
    package: {
      id: 'pkg-1',
      organizationId: 'org-1',
      claimItemId: 'ci-1',
      packageVersion: 'v1',
      packageDigest: 'dg-pkg',
      status: 'GENERATED',
    },
    artifacts: [
      { id: 'art-1', packageId: 'pkg-1', artifactKind: 'PDF', sha256: 's1', fileAssetId: 'fa-1' },
      { id: 'art-2', packageId: 'pkg-2', artifactKind: 'JSON_MANIFEST', sha256: 's2', fileAssetId: 'fa-9' },
    ],
    fileAssets: [
      { id: 'fa-1', organizationId: 'org-1', storageKey: 'k1' },
      { id: 'fa-9', organizationId: 'org-other', storageKey: 'k9' },
    ],
    auditLogs: [
      { id: 'log-1', entityId: 'pkg-1', action: 'RECOVERY_PACKAGE_CREATED' },
      { id: 'log-2', entityId: 'pkg-other', action: 'NOISE' },
    ],
    planDigest: 'dg-plan',
  });

  it('P2E-G13 投影链固定且业务身份为 packageDigest、追溯 basis 为 planDigest', () => {
    const r = buildRecoveryPackageLineageProjection(base());
    expect(r.chain).toEqual([
      'CanonicalSourceFacts',
      'RecoveryPackage',
      'RecoveryPackageArtifact',
      'FileAsset',
      'packageDigest',
      'AuditLog',
    ]);
    expect(r.businessIdentity).toBe('packageDigest');
    expect(r.identityValue).toBe('dg-pkg');
    expect(r.traceBasis).toBe('planDigest');
    expect(r.planDigest).toBe('dg-plan');
  });

  it('P2E-G14 tenant isolation：只收本租户 artifact / fileAsset / audit，跨租户引用进 orphan', () => {
    const r = buildRecoveryPackageLineageProjection(base());
    expect(r.artifactIds).toEqual(['art-1']);
    expect(r.fileAssetIds).toEqual(['fa-1']);
    expect(r.orphanFileAssetIds).toEqual([]);
    expect(r.auditLogIds).toEqual(['log-1']);
  });

  it('P2E-G15 artifact 指向别的 package 时不进入本包投影（不产生跨包 lineage）', () => {
    const input = base();
    input.artifacts = [
      { id: 'art-1', packageId: 'pkg-1', artifactKind: 'PDF', sha256: 's1', fileAssetId: 'fa-1' },
      { id: 'art-x', packageId: 'pkg-1', artifactKind: 'PDF', sha256: 'sx', fileAssetId: 'fa-missing' },
    ];
    const r = buildRecoveryPackageLineageProjection(input);
    expect(r.artifactIds).toEqual(['art-1', 'art-x']);
    expect(r.fileAssetIds).toEqual(['fa-1']);
    expect(r.orphanFileAssetIds).toEqual(['fa-missing']);
  });
});
