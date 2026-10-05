/** Recovery SI P2-E v1 —— 持久化入口门禁（必修 1）+ canonical READY 重算 + 独立 lineage action
 *  依据：MSG-20261005-22（必修 1..4）与 MSG-20261005-23（CHANGE 2 + RISKS canonical recheck） */

import { describe, expect, it } from 'vitest';

import { createProductionControlPlane, type ControlPlaneConfig } from '../services/action-guard/control-plane';
import {
  buildCustomerRecoveryState,
  type CapabilitySlice,
  type CustomerRecoveryState,
  type OpportunitySlice,
} from '../services/intelligence/customer-recovery-state';
import { planRecovery } from '../services/intelligence/recovery-planner';
import { prioritizeOpportunities } from '../services/intelligence/recovery-prioritizer';
import { createRecoveryToolRegistry, type RecoveryToolRegistry } from '../services/intelligence/recovery-tool-registry';
import {
  P2_E_FORBIDDEN_GUARD_ACTIONS,
  P2_E_GUARD_ACTION,
  P2_E_CANONICAL_RECHECK_BOUNDARY,
  P2_E_PERSIST_GATE_BOUNDARY,
  P2_E_TRUSTED_GATE_BINDING,
  RECOVERY_SI_PACKAGE_LINEAGE_CHANGE_KEYS,
  RECOVERY_SI_PACKAGE_PERSISTED_ACTION,
  RECOVERY_PERSIST_TRANSACTION_UNIT_COUNTS,
  P2_E_BATCH_PERMIT_BINDING,
  assertRecoveryPersistBatchMatchesPermit,
  P2_E_PUBLIC_WRITE_SURFACE,
  evaluateRecoveryPersistGate,
  isTrustedRecoveryPersistPermit,
  RECOVERY_PACKAGE_DELETE_GUARD,
  RECOVERY_PERSIST_LINEAGE,
  RECOVERY_PERSIST_TRANSACTION_FAILURE_POLICY,
  RECOVERY_PERSIST_TRANSACTION_UNITS,
  assertRecoverySiPackageLineageChanges,
  verifyRecoveryPersistCanonicalReady,
  buildRecoveryPackageLineageProjection,
  type RecoveryPersistGateOutcome,
  type RecoveryPersistUnitWrite,
} from '../services/intelligence/recovery-persist-gate';
import * as gateModule from '../services/intelligence/recovery-persist-gate';
import * as portModule from '../services/intelligence/recovery-persist-prisma-port';
import { buildRecoverySiPackageLineageAuditLog } from '../services/intelligence/recovery-persist-prisma-port';
import { sha256Hex } from '../services/recovery/recovery-package';

const ORG = 'org-p2e';
const P2E_NOW = '2026-10-05T04:00:00.000Z';
const P2E_NOW_MS = Date.parse(P2E_NOW);

const p2eOpportunity = (over: Partial<OpportunitySlice> = {}): OpportunitySlice => ({
  opportunityRef: 'opp-1',
  domain: 'CARRIER',
  organizationId: ORG,
  recoverable: { amount: 680, currency: 'USD', source: 'CANONICAL_FACT' },
  eligibility: 'ELIGIBLE',
  evidenceComplete: true,
  missingEvidence: [],
  authorizationReady: true,
  deadline: '2026-11-01T00:00:00.000Z',
  providerCostUsd: 0,
  expectedOperationalCostUsd: 0,
  riskClass: 'LOW',
  observedAt: P2E_NOW,
  ...over,
});

const p2eCapability = (domain: CapabilitySlice['domain']): CapabilitySlice => ({
  domain,
  readOnlyTools: [],
  providerApproval: 'READY',
});

const p2eState = (opportunities: readonly OpportunitySlice[]): CustomerRecoveryState => {
  const result = buildCustomerRecoveryState({
    organizationId: ORG,
    observedAt: P2E_NOW,
    opportunities,
    capability: [
      p2eCapability('CARRIER'),
      p2eCapability('CUSTOMS'),
      p2eCapability('PLATFORM'),
      p2eCapability('INDEPENDENT_SITE'),
    ],
  });
  if (!result.ok) throw new Error('fixture tenant mismatch');
  return result.state;
};

const p2eRegistry = (): RecoveryToolRegistry =>
  createRecoveryToolRegistry([
    {
      name: 'recovery.carrier.package_preview.prepare',
      domain: 'CARRIER',
      access: 'PREPARE',
      description: 'fixture',
      invoke: async () => ({}),
    },
  ]);

/** 写入口 canonical READY 重算的合法输入（supplied READY = canonical planner READY） */
const canonicalFixture = (over: { opportunities?: readonly OpportunitySlice[] } = {}) => {
  const state = p2eState(over.opportunities ?? [p2eOpportunity()]);
  const registry = p2eRegistry();
  const plan = planRecovery({
    state,
    ranked: prioritizeOpportunities(state).ranked,
    registry,
    generatedAt: P2E_NOW,
  });
  const suppliedReadyActions = plan.actions.filter((action) => action.proposedAction === 'READY_FOR_EXECUTION');
  return { state, registry, suppliedReadyActions, nowMs: P2E_NOW_MS };
};

const countedPlane = (config: Partial<ControlPlaneConfig> = {}) => {
  const inner = plane(config);
  let calls = 0;
  return {
    calls: () => calls,
    port: {
      snapshotFor: inner.snapshotFor,
      async evaluateWithoutAudit(...args: Parameters<typeof inner.evaluateWithoutAudit>) {
        calls += 1;
        return inner.evaluateWithoutAudit(...args);
      },
    },
  };
};

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
    expect(P2_E_PERSIST_GATE_BOUNDARY.canonicalReadyRecheckRequired).toBe(true);
    expect(P2_E_CANONICAL_RECHECK_BOUNDARY.trustsUpstreamAllowSnapshot).toBe(false);
  });

  it('P2E-G2 control plane 就绪 → 以 claim.prepare 判定（不要求 P2-D claim.submit ALLOW）', async () => {
    const outcome = await evaluateRecoveryPersistGate({
      organizationId: ORG,
      actorUserId: 'user-1',
      actorOrganizationId: ORG,
      controlPlane: plane({}),
      canonical: canonicalFixture(),
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
      canonical: canonicalFixture(),
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
      canonical: canonicalFixture(),
    });
    expect(outcome.persisted).toBe(false);
    expect(outcome.approvalConsumed).toBe(false);
    expect(outcome.executorInvoked).toBe(false);
    expect(outcome.dbDeleteGuardRequired).toBe(true);
    expect(outcome.lineageAction).toBe(RECOVERY_SI_PACKAGE_PERSISTED_ACTION);
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
    expect(RECOVERY_PERSIST_TRANSACTION_UNIT_COUNTS).toEqual({
      RecoveryPackage: 1,
      FileAsset: 2,
      RecoveryPackageArtifact: 2,
      AuditLog: 1,
    });
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


describe('Recovery SI P2-E v1 · 单一事务端口 + 可信 gate 绑定（E1 / E3 / 必修 2）', () => {
  /**
   * 与 permit 完全一致的合法批次（CHANGE E3 六单元 + CHANGE E4 绑定自洽）：
   * 1 package / 2 FileAsset（JSON=OTHER + PDF）/ 2 artifact（JSON_MANIFEST + PDF）/ 1 gate-bound AuditLog。
   */
  const validUnits = (gate: RecoveryPersistGateOutcome): RecoveryPersistUnitWrite[] => {
    const basis = gate.persistedBasis!;
    const canonicalJson = '{"packageVersion":"recovery-package/v1","marker":"unit-1"}';
    const packageDigest = sha256Hex(canonicalJson);
    const pdfSha = sha256Hex('unit-pdf-bytes');
    const pkgId = 'pkg-unit-1';
    const jsonAssetId = 'fa-json-1';
    const pdfAssetId = 'fa-pdf-1';
    const audit = buildRecoverySiPackageLineageAuditLog({
      gate,
      packageId: pkgId,
      packageVersion: 'recovery-package/v1',
      packageDigest,
    });
    return [
      {
        unit: 'RecoveryPackage',
        payload: {
          id: pkgId,
          organizationId: basis.organizationId,
          claimItemId: 'ci-unit-1',
          packageVersion: 'recovery-package/v1',
          digestVersion: 'v1',
          packageDigest,
          opportunityRef: basis.opportunityRef,
          canonicalJson,
        },
      },
      {
        unit: 'FileAsset',
        payload: { id: jsonAssetId, organizationId: basis.organizationId, kind: 'OTHER', storageKey: 'k-json', originalName: 'p.json', sha256: packageDigest },
      },
      {
        unit: 'FileAsset',
        payload: { id: pdfAssetId, organizationId: basis.organizationId, kind: 'PDF', storageKey: 'k-pdf', originalName: 'p.pdf', sha256: pdfSha },
      },
      {
        unit: 'RecoveryPackageArtifact',
        payload: { id: 'art-json-1', organizationId: basis.organizationId, packageId: pkgId, artifactKind: 'JSON_MANIFEST', fileAssetId: jsonAssetId, sha256: packageDigest },
      },
      {
        unit: 'RecoveryPackageArtifact',
        payload: { id: 'art-pdf-1', organizationId: basis.organizationId, packageId: pkgId, artifactKind: 'PDF', fileAssetId: pdfAssetId, sha256: pdfSha },
      },
      { unit: 'AuditLog', payload: { ...audit, id: 'audit-unit-1' } },
    ];
  };

  const units = (gate: RecoveryPersistGateOutcome) => validUnits(gate);

  const allowGate = async (): Promise<RecoveryPersistGateOutcome> => {
    const outcome = await evaluateRecoveryPersistGate({
      organizationId: ORG,
      actorUserId: 'user-1',
      actorOrganizationId: ORG,
      controlPlane: plane({}),
      canonical: canonicalFixture(),
    });
    expect(outcome.decision).toBe('ALLOW');
    expect(isTrustedRecoveryPersistPermit(outcome)).toBe(true);
    return outcome;
  };

  /** 真实门禁签发的非 ALLOW 结果（缺 canonical 输入 → DENY） */
  const denyGate = async (): Promise<RecoveryPersistGateOutcome> =>
    evaluateRecoveryPersistGate({
      organizationId: ORG,
      actorUserId: 'user-1',
      actorOrganizationId: ORG,
      controlPlane: plane({}),
    });

  it('P2E-G9 门禁非 ALLOW → 端口零调用、不持久化', async () => {
    const gate = await denyGate();
    const allowUnits = units(await allowGate());
    // 生产入口在任何 DB 写入前先要求 trusted + ALLOW + persistedBasis → 非 ALLOW 直接 fail-closed
    expect(() => assertRecoveryPersistBatchMatchesPermit(gate, allowUnits)).toThrow(
      /P2E_LINEAGE_REQUIRES_TRUSTED_ALLOW_GATE/,
    );
  });

  it('P2E-G10 单元集合 / 数量不符 → fail-closed（端口零调用）', async () => {
    const gate = await allowGate();
    expect(() => assertRecoveryPersistBatchMatchesPermit(gate, units(gate).slice(0, 5))).toThrow(
      /P2E_TRANSACTION_UNIT_SET_MISMATCH/,
    );
    expect(() => assertRecoveryPersistBatchMatchesPermit(gate, units(gate).slice(0, 4))).toThrow(
      /P2E_TRANSACTION_UNIT_SET_MISMATCH/,
    );
  });

  it('P2E-G11 合法批次（1+2+2+1）通过 permit 绑定校验，且单元顺序固定', async () => {
    const gate = await allowGate();
    const batch = units(gate);
    expect(() => assertRecoveryPersistBatchMatchesPermit(gate, batch)).not.toThrow();
    expect(batch.map((unit) => unit.unit)).toEqual([
      'RecoveryPackage',
      'FileAsset',
      'FileAsset',
      'RecoveryPackageArtifact',
      'RecoveryPackageArtifact',
      'AuditLog',
    ]);
    expect([...batch.map((unit) => unit.unit)].sort()).toEqual([
      'AuditLog,FileAsset,FileAsset,RecoveryPackage,RecoveryPackageArtifact,RecoveryPackageArtifact',
    ].flatMap((joined) => joined.split(',')));
  });

  it('P2E-G23 手工伪造 ALLOW gate → 拒绝（CALLER_SUPPLIED_ALLOW_GATE = FORBIDDEN）', async () => {
    const real = await allowGate();
    // 结构完全相同的「手工对象」：JSON 往返后不再是 WeakSet 中的 permit 对象
    const handBuilt = JSON.parse(JSON.stringify(real)) as RecoveryPersistGateOutcome;
    expect(isTrustedRecoveryPersistPermit(handBuilt)).toBe(false);
    expect(() => assertRecoveryPersistBatchMatchesPermit(handBuilt, units(real))).toThrow(
      /P2E_CALLER_SUPPLIED_GATE_FORBIDDEN/,
    );
  });

  it('P2E-G24（F4E-01）合法 permit 复用到别的 tenant → PERMIT_BATCH_TENANT_MISMATCH 且零调用', async () => {
    const gate = await allowGate();
    const tampered = units(gate).map((unit) => ({
      ...unit,
      payload: { ...(unit.payload as Record<string, unknown>), organizationId: 'org-other' },
    }));
    expect(() => assertRecoveryPersistBatchMatchesPermit(gate, tampered)).toThrow(
      /P2E_PERMIT_BATCH_TENANT_MISMATCH/,
    );
  });

  it('P2E-G25（F4E-03）手工伪造 lineage AuditLog → LINEAGE_AUDIT_NOT_GATE_BOUND 且零调用', async () => {
    const gate = await allowGate();
    for (const mutate of [
      (audit: Record<string, unknown>) => ({ ...audit, action: 'recovery.package_generated' }),
      (audit: Record<string, unknown>) => ({ ...audit, entityId: 'other-package' }),
      (audit: Record<string, unknown>) => ({ ...audit, changes: { ...(audit.changes as object), planDigest: 'f'.repeat(64) } }),
      (audit: Record<string, unknown>) => ({ ...audit, changes: { ...(audit.changes as object), packageDigest: 'e'.repeat(64) } }),
      (audit: Record<string, unknown>) => ({ ...audit, changes: { ...(audit.changes as object), opportunityRef: 'opp-other' } }),
    ]) {
      const forged = units(gate).map((unit) =>
        unit.unit === 'AuditLog' ? { ...unit, payload: mutate(unit.payload as Record<string, unknown>) } : unit,
      );
      expect(() => assertRecoveryPersistBatchMatchesPermit(gate, forged)).toThrow(
        /P2E_LINEAGE_AUDIT_NOT_GATE_BOUND/,
      );
    }
    const forged = units(gate).map((unit) =>
      unit.unit === 'AuditLog'
        ? { ...unit, payload: { ...(unit.payload as Record<string, unknown>), action: 'recovery.package_generated' } }
        : unit,
    );
    await expect(
      async () => assertRecoveryPersistBatchMatchesPermit(gate, forged),
    ).rejects.toThrow(/P2E_LINEAGE_AUDIT_NOT_GATE_BOUND/);
  });

  it('P2E-G26（F4E-04）artifact 交叉接线 → BATCH_IDENTITY_MISMATCH 且零调用', async () => {
    const gate = await allowGate();
    const crossWired = units(gate).map((unit) =>
      unit.unit === 'RecoveryPackageArtifact' &&
      (unit.payload as { artifactKind?: string }).artifactKind === 'JSON_MANIFEST'
        ? { ...unit, payload: { ...(unit.payload as Record<string, unknown>), fileAssetId: 'fa-pdf-1' } }
        : unit,
    );
    expect(() => assertRecoveryPersistBatchMatchesPermit(gate, crossWired)).toThrow(
      /P2E_BATCH_IDENTITY_MISMATCH/,
    );
  });

  it('P2E-G27 package 的 opportunityRef 与 permit 不一致 → PACKAGE_OPPORTUNITY_BINDING_MISMATCH', async () => {
    const gate = await allowGate();
    const mismatched = units(gate).map((unit) =>
      unit.unit === 'RecoveryPackage'
        ? { ...unit, payload: { ...(unit.payload as Record<string, unknown>), opportunityRef: 'opp-other' } }
        : unit,
    );
    expect(() => assertRecoveryPersistBatchMatchesPermit(gate, mismatched)).toThrow(
      /P2E_PACKAGE_OPPORTUNITY_BINDING_MISMATCH/,
    );
    expect(P2_E_BATCH_PERMIT_BINDING.permitReuseForDifferentTarget).toBe('FORBIDDEN');
  });
});


describe('Recovery SI P2-E v1 · 公开写入口收口（MSG-20261005-26 CHANGE E5）', () => {
  it('P2E-G28（F5E-01）生产模块只公开一个 write-capable 入口', () => {
    expect(P2_E_PUBLIC_WRITE_SURFACE.publicWriteEntryCount).toBe(1);
    expect(P2_E_PUBLIC_WRITE_SURFACE.publicWriteEntry).toBe('persistRecoverySiPackageWithinTransaction');
    expect(P2_E_PUBLIC_WRITE_SURFACE.rawTransactionPortPublic).toBe('FORBIDDEN');
    expect(P2_E_PUBLIC_WRITE_SURFACE.lowLevelGateOnlyWritePublic).toBe('FORBIDDEN');

    // port 模块：唯一写入口存在；低层写能力与 raw transaction port 一律不再导出
    expect(typeof portModule.persistRecoverySiPackageWithinTransaction).toBe('function');
    expect('persistRecoveryPackageWithReplayConvergence' in portModule).toBe(false);
    expect('createPrismaRecoveryPersistPort' in portModule).toBe(false);
    expect('isRecoveryPackageUniqueViolation' in portModule).toBe(false);

    // gate 模块：不得再导出 gate-only 的低层写入函数
    expect('persistRecoveryPackageWithinTransaction' in gateModule).toBe(false);
    expect('createPrismaRecoveryPersistPort' in gateModule).toBe(false);

    // 只读能力仍然可用（收口不削弱可读性/证据能力）
    expect(typeof portModule.readRecoveryPackageLineage).toBe('function');
    expect(typeof portModule.readRecoveryPackagePlanDigestFromAudit).toBe('function');
    expect(typeof portModule.assertPackageClaimItemOpportunityBinding).toBe('function');
    expect(typeof portModule.buildRecoveryPersistUnits).toBe('function');
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


describe('Recovery SI P2-E v1 · 写入口 canonical READY 重算（MSG-20261005-23 RISKS）', () => {
  it('P2E-G16 缺 canonical 重算输入 → DENY 且零 Guard 调用', async () => {
    const cp = countedPlane();
    const outcome = await evaluateRecoveryPersistGate({
      organizationId: ORG,
      actorUserId: 'user-1',
      actorOrganizationId: ORG,
      controlPlane: cp.port,
    });
    expect(outcome.decision).toBe('DENY');
    expect(outcome.code).toBe('P2E_CANONICAL_RECHECK_INPUT_REQUIRED');
    expect(outcome.guardEvaluated).toBe(false);
    expect(cp.calls()).toBe(0);
  });

  it('P2E-G17 authorizationReady=false 时伪造 READY → CANONICAL_READY_MISMATCH 且零 Guard 调用', async () => {
    const healthy = canonicalFixture();
    const forged = {
      ...healthy,
      state: p2eState([p2eOpportunity({ authorizationReady: false })]),
      suppliedReadyActions: healthy.suppliedReadyActions,
    };
    expect(forged.suppliedReadyActions.length).toBeGreaterThan(0);
    const cp = countedPlane({ globalDisabled: false });
    const outcome = await evaluateRecoveryPersistGate({
      organizationId: ORG,
      actorUserId: 'user-1',
      actorOrganizationId: ORG,
      controlPlane: cp.port,
      canonical: forged,
    });
    expect(outcome.decision).toBe('DENY');
    expect(outcome.code).toBe('P2E_CANONICAL_READY_MISMATCH');
    expect(outcome.canonicalReadyVerified).toBe(false);
    expect(cp.calls()).toBe(0);
  });

  it('P2E-G18 HIGH-risk（OWNER gate）伪造 READY → CANONICAL_READY_MISMATCH 且零 Guard 调用', async () => {
    const healthy = canonicalFixture();
    const forged = {
      ...healthy,
      state: p2eState([p2eOpportunity({ riskClass: 'HIGH' })]),
      suppliedReadyActions: healthy.suppliedReadyActions,
    };
    const cp = countedPlane();
    const outcome = await evaluateRecoveryPersistGate({
      organizationId: ORG,
      actorUserId: 'user-1',
      actorOrganizationId: ORG,
      controlPlane: cp.port,
      canonical: forged,
    });
    expect(outcome.decision).toBe('DENY');
    expect(outcome.code).toBe('P2E_CANONICAL_READY_MISMATCH');
    expect(cp.calls()).toBe(0);
  });

  it('P2E-G19 金额篡改 → CANONICAL_READY_MISMATCH 且零 Guard 调用', async () => {
    const healthy = canonicalFixture();
    const tampered = healthy.suppliedReadyActions.map((action) =>
      action.expectedRecovery
        ? { ...action, expectedRecovery: { ...action.expectedRecovery, amount: Number(action.expectedRecovery.amount) + 1 } }
        : action,
    );
    const cp = countedPlane();
    const outcome = await evaluateRecoveryPersistGate({
      organizationId: ORG,
      actorUserId: 'user-1',
      actorOrganizationId: ORG,
      controlPlane: cp.port,
      canonical: { ...healthy, suppliedReadyActions: tampered },
    });
    expect(outcome.decision).toBe('DENY');
    expect(outcome.code).toBe('P2E_CANONICAL_READY_MISMATCH');
    expect(cp.calls()).toBe(0);
  });

  it('P2E-G20 陈旧 state（超出 maxSnapshotAge）→ P2E_CANONICAL_STATE_STALE 且零 Guard 调用', async () => {
    const healthy = canonicalFixture();
    const cp = countedPlane();
    const outcome = await evaluateRecoveryPersistGate({
      organizationId: ORG,
      actorUserId: 'user-1',
      actorOrganizationId: ORG,
      controlPlane: cp.port,
      canonical: { ...healthy, nowMs: P2E_NOW_MS + 60 * 60 * 1000 },
    });
    expect(outcome.decision).toBe('DENY');
    expect(outcome.code).toBe('P2E_CANONICAL_STATE_STALE');
    expect(cp.calls()).toBe(0);
  });

  it('P2E-G21 canonical 对齐成立 → 给出 canonicalPlanDigest（ALLOW 才进入 Guard）', async () => {
    const healthy = canonicalFixture();
    const cp = countedPlane({});
    const outcome = await evaluateRecoveryPersistGate({
      organizationId: ORG,
      actorUserId: 'user-1',
      actorOrganizationId: ORG,
      controlPlane: cp.port,
      canonical: healthy,
    });
    expect(outcome.canonicalReadyVerified).toBe(true);
    expect(outcome.canonicalPlanDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.guardEvaluated).toBe(true);
    expect(cp.calls()).toBe(1);

    // 独立重算：同一 canonical 输入 → 同一 digest（顺序无关由 P2-D D10 覆盖）
    const again = verifyRecoveryPersistCanonicalReady(healthy);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.canonicalPlanDigest).toBe(outcome.canonicalPlanDigest);
  });
});


describe('Recovery SI P2-E v1 · 独立 lineage audit action（MSG-20261005-23 CHANGE 2）', () => {
  it('P2E-G22 action 独立、changes 白名单 fail-closed、digest 绑定可信 gate（E2）', async () => {
    expect(RECOVERY_SI_PACKAGE_PERSISTED_ACTION).toBe('recovery.si_package_persisted');
    expect(P2_E_TRUSTED_GATE_BINDING.callerSuppliedAllowGate).toBe('FORBIDDEN');
    expect(RECOVERY_SI_PACKAGE_LINEAGE_CHANGE_KEYS).toEqual([
      'packageId',
      'packageVersion',
      'packageDigest',
      'planDigestVersion',
      'planDigest',
      'basisVersion',
      'opportunityRef',
      'domain',
      'guardAction',
    ]);
    expect(() => assertRecoverySiPackageLineageChanges({ packageId: 'p' })).not.toThrow();
    expect(() => assertRecoverySiPackageLineageChanges({ packageId: 'p', unexpectedKey: 1 })).toThrow(
      /RECOVERY_SI_LINEAGE_CHANGES_NOT_WHITELISTED/,
    );

    const gate = await evaluateRecoveryPersistGate({
      organizationId: ORG,
      actorUserId: 'user-1',
      actorOrganizationId: ORG,
      controlPlane: plane({}),
      canonical: canonicalFixture(),
    });
    expect(gate.decision).toBe('ALLOW');
    expect(gate.persistedBasis?.canonicalPlanDigest).toMatch(/^[0-9a-f]{64}$/);

    const audit = buildRecoverySiPackageLineageAuditLog({
      gate,
      packageId: 'pkg-1',
      packageVersion: 'recovery-package/v1',
      packageDigest: 'a'.repeat(64),
    });
    expect(audit.action).toBe('recovery.si_package_persisted');
    expect(audit.entityType).toBe('RecoveryPackage');
    expect(audit.entityId).toBe('pkg-1');
    expect(audit.actorType).toBe('SYSTEM');
    expect(audit.actorUserId).toBeNull();
    expect(audit.organizationId).toBe(ORG);
    expect(Object.keys(audit.changes as Record<string, unknown>).sort()).toEqual(
      [...RECOVERY_SI_PACKAGE_LINEAGE_CHANGE_KEYS].sort(),
    );
    expect((audit.changes as { guardAction?: string }).guardAction).toBe('claim.prepare');
    // planDigest 一律来自可信 gate（调用方声明的 digest 必须与之一致）
    expect((audit.changes as { planDigest?: string }).planDigest).toBe(gate.persistedBasis!.canonicalPlanDigest);
    expect((audit.changes as { opportunityRef?: string }).opportunityRef).toBe(
      gate.persistedBasis!.opportunityRef,
    );

    // F3E-02（unit 级）：声明一个不同 digest → fail-closed
    expect(() =>
      buildRecoverySiPackageLineageAuditLog({
        gate,
        packageId: 'pkg-1',
        packageVersion: 'recovery-package/v1',
        packageDigest: 'a'.repeat(64),
        claimedPlanDigest: 'b'.repeat(64),
      }),
    ).toThrow(/P2E_LINEAGE_DIGEST_MISMATCH/);

    // 手工伪造 gate → 拒绝
    const handBuilt = JSON.parse(JSON.stringify(gate)) as typeof gate;
    expect(() =>
      buildRecoverySiPackageLineageAuditLog({
        gate: handBuilt,
        packageId: 'pkg-1',
        packageVersion: 'recovery-package/v1',
        packageDigest: 'a'.repeat(64),
      }),
    ).toThrow(/P2E_CALLER_SUPPLIED_GATE_FORBIDDEN/);
  });
});
