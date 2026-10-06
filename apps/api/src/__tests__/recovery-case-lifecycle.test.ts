// PROVIDER FOLLOW-UP INTELLIGENCE / P7 — slice A-S8 — Recovery Case Lifecycle 投影回归
// ---------------------------------------------------------------------------
// 覆盖：阶段派生、只复用既有事实（无新状态机）、「内部准备完成 ≠ 平台已收到」分离不变量、
// 未验证来源不得升级、金额只投影不重算、阻断原因、租户隔离、确定性摘要。

import { describe, expect, it } from 'vitest';

import * as providerSupport from '../services/provider-support';
import {
  LIFECYCLE_BOUNDARY,
  LIFECYCLE_FACT_SOURCES,
  LIFECYCLE_STAGES,
  RECOVERY_CASE_LIFECYCLE_VERSION,
  RecoveryCaseLifecycleError,
  assertLifecycleSeparation,
  deriveLifecycleStage,
  projectRecoveryCaseLifecycle,
  type RecoveryCaseLifecycleSnapshot,
} from '../services/provider-support';

const NOW = new Date('2026-10-06T10:00:00.000Z');
const ORG = 'org-1';

function snapshot(overrides: Partial<RecoveryCaseLifecycleSnapshot> = {}): RecoveryCaseLifecycleSnapshot {
  return {
    organizationId: ORG,
    caseId: 'case-1',
    caseNo: 'C-0001',
    domain: 'PLATFORM',
    caseStatus: 'OPEN',
    openedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function project(overrides: Partial<RecoveryCaseLifecycleSnapshot> = {}, observedAt: Date = NOW) {
  return projectRecoveryCaseLifecycle({
    scope: { organizationId: ORG },
    snapshot: snapshot(overrides),
    observedAt,
  });
}

const FOUND_POD = { kind: 'POD', status: 'FOUND' as const, evidenceReferences: ['ev-pod'], resultDigest: 'd-pod' };
const MISSING_POD = {
  kind: 'POD',
  status: 'MISSING' as const,
  evidenceReferences: [],
  resultDigest: 'd-pod-missing',
};

describe('A-S8 Lifecycle — 阶段派生（纯投影）', () => {
  it('OPEN 且无任何事实 → INTAKE', () => {
    const projection = project();
    expect(projection.stage).toBe('INTAKE');
    expect(projection.kind).toBe('RECOVERY_CASE_LIFECYCLE');
    expect(projection.version).toBe(RECOVERY_CASE_LIFECYCLE_VERSION);
    expect(projection.derivedOnly).toBe(true);
  });

  it('证据缺失 → EVIDENCE_INCOMPLETE（列出缺口）', () => {
    const projection = project({
      caseStatus: 'COLLECTING_EVIDENCE',
      requiredEvidenceKinds: ['POD', 'COMMERCIAL_INVOICE'],
      evidenceResolutions: [MISSING_POD],
    });
    expect(projection.stage).toBe('EVIDENCE_INCOMPLETE');
    expect(projection.reasons).toContain('MISSING_EVIDENCE:COMMERCIAL_INVOICE,POD');
    expect(projection.internal.evidenceComplete).toBe(false);
  });

  it('已生成补料草稿 → FOLLOW_UP_DRAFTED', () => {
    const projection = project({
      caseStatus: 'COLLECTING_EVIDENCE',
      evidenceResolutions: [MISSING_POD],
      followUp: { status: 'DRAFT', approvalRequired: false, approvalRole: null, highValue: false },
    });
    expect(projection.stage).toBe('FOLLOW_UP_DRAFTED');
    expect(projection.internal.followUpDrafted).toBe(true);
  });

  it('必需证据全部 FOUND → EVIDENCE_COMPLETE', () => {
    const projection = project({ caseStatus: 'READY_TO_CLAIM', evidenceResolutions: [FOUND_POD] });
    expect(projection.stage).toBe('EVIDENCE_COMPLETE');
    expect(projection.internal.evidenceComplete).toBe(true);
  });

  it('存在 GENERATED 包 → PACKAGE_GENERATED', () => {
    const projection = project({
      caseStatus: 'READY_TO_CLAIM',
      evidenceResolutions: [FOUND_POD],
      packages: [
        { packageId: 'p1', status: 'GENERATED', packageDigest: 'dig-1', generatedAt: '2026-10-02T00:00:00.000Z' },
      ],
    });
    expect(projection.stage).toBe('PACKAGE_GENERATED');
    expect(projection.internal.packageGenerated).toBe(true);
    expect(projection.internal.packageExported).toBe(false);
  });

  it('存在 EXPORTED 包且无需审批 → PACKAGE_EXPORTED（内部准备完成）', () => {
    const projection = project({
      packages: [
        { packageId: 'p1', status: 'EXPORTED', packageDigest: 'dig-1', generatedAt: '2026-10-02T00:00:00.000Z' },
      ],
    });
    expect(projection.stage).toBe('PACKAGE_EXPORTED');
    expect(projection.internal.internalReady).toBe(true);
    expect(projection.provider.providerReceived).toBe(false);
  });

  it('high-value 且未审批 → AWAITING_APPROVAL（即使包已 EXPORTED）', () => {
    const projection = project({
      packages: [
        { packageId: 'p1', status: 'EXPORTED', packageDigest: 'dig-1', generatedAt: '2026-10-02T00:00:00.000Z' },
      ],
      followUp: { status: 'DRAFT', approvalRequired: true, approvalRole: 'OWNER', highValue: true },
    });
    expect(projection.stage).toBe('AWAITING_APPROVAL');
    expect(projection.internal.internalReady).toBe(false);
    expect(projection.blockers).toContain('HIGH_VALUE_APPROVAL_REQUIRED');
  });

  it('已记录人工提交 → SUBMISSION_RECORDED（仍不等同平台已收到）', () => {
    const projection = project({
      packages: [
        { packageId: 'p1', status: 'EXPORTED', packageDigest: 'dig-1', generatedAt: '2026-10-02T00:00:00.000Z' },
      ],
      submission: { submissionId: 's1', submittedAt: '2026-10-03T00:00:00.000Z', packageDigest: 'dig-1' },
    });
    expect(projection.stage).toBe('SUBMISSION_RECORDED');
    expect(projection.internal.submissionRecorded).toBe(true);
    expect(projection.provider.providerReceived).toBe(false);
    expect(projection.provider.acknowledgement).toBe('NONE');
  });

  it('用户自述 provider case ref → PROVIDER_REFERENCE_RECORDED（不是平台 ACK）', () => {
    const projection = project({
      submission: { submissionId: 's1', submittedAt: '2026-10-03T00:00:00.000Z', packageDigest: 'dig-1' },
      providerReference: {
        providerCaseRefCanonical: 'AMZ-123456',
        recordedAt: '2026-10-03T01:00:00.000Z',
        source: 'USER_RECORDED',
      },
    });
    expect(projection.stage).toBe('PROVIDER_REFERENCE_RECORDED');
    expect(projection.provider.referenceRecorded).toBe(true);
    expect(projection.provider.providerReceived).toBe(false);
    expect(projection.omittedBecauseUnverified).toContain('PROVIDER_CASE_REFERENCE_AS_RECEIPT');
  });

  it('provider 已验证 ACK → PROVIDER_ACKNOWLEDGED', () => {
    const projection = project({
      providerAcknowledgement: {
        source: 'PROVIDER_VERIFIED',
        acknowledgedAt: '2026-10-04T00:00:00.000Z',
        providerCaseId: 'case-1001',
      },
    });
    expect(projection.stage).toBe('PROVIDER_ACKNOWLEDGED');
    expect(projection.provider.acknowledgement).toBe('VERIFIED');
    expect(projection.provider.providerReceived).toBe(true);
  });

  it('结算经 VERIFIED 来源确认 → SETTLED', () => {
    const projection = project({
      settlement: {
        settlementId: 'st-1',
        confirmationStatus: 'CONFIRMED',
        reconciliationStatus: 'PARTIAL',
        verifiedSource: 'AUTHORITY_VERIFIED',
        amountUsd: 1_250,
        confirmedAt: '2026-10-05T00:00:00.000Z',
      },
    });
    expect(projection.stage).toBe('SETTLED');
    expect(projection.provider.settlementConfirmed).toBe(true);
    expect(projection.money.settledAmountUsd).toBe(1_250);
  });

  it('对账 MATCHED → RECONCILED（最高阶段）', () => {
    const projection = project({
      reconciliation: { status: 'MATCHED', reconciledAt: '2026-10-05T06:00:00.000Z' },
      settlement: {
        settlementId: 'st-1',
        confirmationStatus: 'CONFIRMED',
        reconciliationStatus: 'RECONCILED',
        verifiedSource: 'PROVIDER_VERIFIED',
      },
    });
    expect(projection.stage).toBe('RECONCILED');
    expect(projection.provider.reconciliationStatus).toBe('MATCHED');
  });

  it('案件已关闭且无更后阶段 → CLOSED', () => {
    const projection = project({ caseStatus: 'CLOSED', closedAt: '2026-10-05T09:00:00.000Z' });
    expect(projection.stage).toBe('CLOSED');
    expect(projection.stageHistory.some((e) => e.stage === 'CLOSED')).toBe(true);
  });
});

describe('A-S8 — 分离不变量：内部准备完成 ≠ 平台已收到', () => {
  it('包已 EXPORTED（内部就绪）不会推导出平台已收到', () => {
    const projection = project({
      packages: [
        { packageId: 'p1', status: 'EXPORTED', packageDigest: 'dig-1', generatedAt: '2026-10-02T00:00:00.000Z' },
      ],
    });
    expect(projection.internal.internalReady).toBe(true);
    expect(projection.provider.providerReceived).toBe(false);
    expect(projection.separation).toMatchObject({ internalReady: true, providerReceived: false, conflated: false });
    expect(projection.separation.basis.join(' ')).toContain('RecoveryPackage.status=EXPORTED');
    expect(projection.separation.basis.join(' ')).toContain('PROVIDER_VERIFIED');
  });

  it('acknowledgement = UNVERIFIED → 不升级为平台已收到，并列入省略项', () => {
    const projection = project({
      providerAcknowledgement: { source: 'UNVERIFIED', acknowledgedAt: null },
    });
    expect(projection.provider.acknowledgement).toBe('UNVERIFIED');
    expect(projection.provider.providerReceived).toBe(false);
    expect(projection.blockers).toContain('PROVIDER_ACK_UNVERIFIED');
    expect(projection.omittedBecauseUnverified).toContain('PROVIDER_ACKNOWLEDGEMENT');
    expect(projection.stage).not.toBe('PROVIDER_ACKNOWLEDGED');
  });

  it('USER_RECORDED 的 provider 引用不得当作平台回执', () => {
    const projection = project({
      providerReference: { providerCaseRefCanonical: 'AMZ-1', recordedAt: '2026-10-03T00:00:00.000Z', source: 'USER_RECORDED' },
    });
    expect(projection.reasons).toContain('USER_RECORDED_REFERENCE_IS_NOT_PROVIDER_RECEIPT');
    expect(projection.provider.providerReceived).toBe(false);
  });

  it('assertLifecycleSeparation：合法投影通过；伪造 VERIFIED / 合并状态被拒绝', () => {
    const projection = project({
      providerAcknowledgement: { source: 'PROVIDER_VERIFIED', acknowledgedAt: '2026-10-04T00:00:00.000Z' },
    });
    expect(() => assertLifecycleSeparation(projection)).not.toThrow();
    expect(() =>
      assertLifecycleSeparation({ provider: { providerReceived: true, acknowledgement: 'UNVERIFIED' } }),
    ).toThrowError(RecoveryCaseLifecycleError);
    expect(() => assertLifecycleSeparation({ separation: { conflated: true } })).toThrowError(
      RecoveryCaseLifecycleError,
    );
  });

  it('边界常量：不新建状态机/表/枚举，内部就绪不蕴含平台已收到', () => {
    expect(LIFECYCLE_BOUNDARY.derivedOnly).toBe(true);
    expect(LIFECYCLE_BOUNDARY.newStateMachine).toBe(false);
    expect(LIFECYCLE_BOUNDARY.newTableOrEnum).toBe(false);
    expect(LIFECYCLE_BOUNDARY.mutatesFacts).toBe(false);
    expect(LIFECYCLE_BOUNDARY.recomputesMoneyTruth).toBe(false);
    expect(LIFECYCLE_BOUNDARY.internalReadyImpliesProviderReceived).toBe(false);
    expect(LIFECYCLE_BOUNDARY.providerReceiptRequiresVerifiedSource).toBe(true);
    expect(LIFECYCLE_BOUNDARY.forbidden).toContain(
      'conflating internal readiness with provider receipt (single SUBMITTED)',
    );
  });
});

describe('A-S8 — 金额投影、阻断与省略项', () => {
  it('结算未经 VERIFIED 来源确认 → 金额为 null（不是 0）并列入省略项', () => {
    const projection = project({
      settlement: {
        settlementId: 'st-1',
        confirmationStatus: 'PENDING_CONFIRMATION',
        reconciliationStatus: 'NOT_STARTED',
        verifiedSource: null,
        amountUsd: 500,
      },
    });
    expect(projection.money.settledAmountUsd).toBeNull();
    expect(projection.blockers).toContain('SETTLEMENT_NOT_CONFIRMED_BY_VERIFIED_SOURCE');
    expect(projection.omittedBecauseUnverified).toContain('SETTLED_AMOUNT');
    expect(projection.money.claimedAmount).toBeNull();
  });

  it('证据冲突 → EVIDENCE_UNRESOLVED 阻断（附 kind）', () => {
    const projection = project({
      evidenceResolutions: [
        { kind: 'POD', status: 'CONFLICT', evidenceReferences: ['ev-a', 'ev-b'], resultDigest: 'd-conflict' },
      ],
    });
    expect(projection.blockers).toContain('EVIDENCE_UNRESOLVED:POD');
  });

  it('提交包 digest 与最新包不一致 → SUBMISSION_PACKAGE_DIGEST_MISMATCH', () => {
    const projection = project({
      packages: [
        { packageId: 'p1', status: 'EXPORTED', packageDigest: 'dig-1', generatedAt: '2026-10-02T00:00:00.000Z' },
      ],
      submission: { submissionId: 's1', submittedAt: '2026-10-03T00:00:00.000Z', packageDigest: 'dig-OTHER' },
    });
    expect(projection.blockers).toContain('SUBMISSION_PACKAGE_DIGEST_MISMATCH');
  });

  it('包被撤销 → PACKAGE_WITHDRAWN 阻断且不推进到 PACKAGE_* 阶段', () => {
    const projection = project({
      evidenceResolutions: [FOUND_POD],
      packages: [
        { packageId: 'p1', status: 'WITHDRAWN', packageDigest: 'dig-1', generatedAt: '2026-10-02T00:00:00.000Z' },
      ],
    });
    expect(projection.blockers).toContain('PACKAGE_WITHDRAWN');
    expect(projection.stage).toBe('EVIDENCE_COMPLETE');
    expect(projection.internal.packageGenerated).toBe(false);
  });

  it('包被取代 → PACKAGE_SUPERSEDED 仅作原因，不阻断新包阶段', () => {
    const projection = project({
      packages: [
        { packageId: 'p1', status: 'SUPERSEDED', packageDigest: 'dig-1', generatedAt: '2026-10-01T00:00:00.000Z' },
        { packageId: 'p2', status: 'EXPORTED', packageDigest: 'dig-2', generatedAt: '2026-10-02T00:00:00.000Z' },
      ],
    });
    expect(projection.reasons).toContain('PACKAGE_SUPERSEDED');
    expect(projection.stage).toBe('PACKAGE_EXPORTED');
  });

  it('结算争议 / 对账未匹配 → 分别阻断', () => {
    const disputed = project({
      settlement: {
        settlementId: 'st-1',
        confirmationStatus: 'CONFIRMED',
        reconciliationStatus: 'DISPUTED',
        verifiedSource: 'PROVIDER_VERIFIED',
      },
    });
    expect(disputed.blockers).toContain('SETTLEMENT_RECONCILIATION_DISPUTED');

    const unmatched = project({ reconciliation: { status: 'UNMATCHED' } });
    expect(unmatched.blockers).toContain('RECONCILIATION_UNMATCHED');
  });

  it('人工复核标记 → AWAITING_MANUAL_REVIEW 阻断', () => {
    const projection = project({ manualReview: { reason: 'PROMPT_INJECTION_SUSPECTED', at: NOW.toISOString() } });
    expect(projection.blockers).toContain('AWAITING_MANUAL_REVIEW');
    expect(projection.reasons).toContain('MANUAL_REVIEW_REASON:PROMPT_INJECTION_SUSPECTED');
  });
});

describe('A-S8 — 复用审计、隔离与确定性', () => {
  it('每个生命周期阶段都对应既有事实来源（无需新建重复状态机）', () => {
    const mapped = new Set(LIFECYCLE_FACT_SOURCES.map((s) => s.stage));
    for (const stage of LIFECYCLE_STAGES) {
      expect(mapped.has(stage)).toBe(true);
    }
    for (const source of LIFECYCLE_FACT_SOURCES) {
      expect(source.model.length).toBeGreaterThan(0);
      expect(source.field.length).toBeGreaterThan(0);
    }
  });

  it('跨 tenant 快照 → LIFECYCLE_TENANT_MISMATCH（fail-closed）', () => {
    expect(() =>
      projectRecoveryCaseLifecycle({
        scope: { organizationId: 'org-1' },
        snapshot: snapshot({ organizationId: 'org-2' }),
        observedAt: NOW,
      }),
    ).toThrowError(RecoveryCaseLifecycleError);
  });

  it('stageHistory 按阶段顺序排列且每条都有事实依据', () => {
    const projection = project({
      caseStatus: 'CLOSED',
      closedAt: '2026-10-05T09:00:00.000Z',
      requiredEvidenceKinds: ['POD'],
      evidenceResolutions: [FOUND_POD],
      packages: [
        { packageId: 'p1', status: 'EXPORTED', packageDigest: 'dig-1', generatedAt: '2026-10-02T00:00:00.000Z' },
      ],
      submission: { submissionId: 's1', submittedAt: '2026-10-03T00:00:00.000Z', packageDigest: 'dig-1' },
    });
    const indexes = projection.stageHistory.map((e) => LIFECYCLE_STAGES.indexOf(e.stage));
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    for (const entry of projection.stageHistory) {
      expect(entry.basis.trim().length).toBeGreaterThan(0);
    }
    expect(projection.stageHistory.map((e) => e.stage)).toContain('PACKAGE_EXPORTED');
  });

  it('确定性：同输入同 observedAt → 同 projectionDigest；observedAt 变 → 摘要变', () => {
    const a = project({ evidenceResolutions: [FOUND_POD] });
    const b = project({ evidenceResolutions: [FOUND_POD] });
    const c = project({ evidenceResolutions: [FOUND_POD] }, new Date('2026-10-06T11:00:00.000Z'));
    expect(a.projectionDigest).toBe(b.projectionDigest);
    expect(a.projectionDigest).not.toBe(c.projectionDigest);
    expect(a.projectionDigest).toHaveLength(64);
  });

  it('deriveLifecycleStage 与 projectRecoveryCaseLifecycle 结论一致（纯函数可单测）', () => {
    const snap = snapshot({ evidenceResolutions: [MISSING_POD] });
    expect(deriveLifecycleStage(snap)).toBe(project({ evidenceResolutions: [MISSING_POD] }).stage);
  });

  it('模块不导出任何状态迁移 / 写库入口（只读投影）', () => {
    for (const name of Object.keys(providerSupport)) {
      expect(name).not.toMatch(/transitionLifecycle|persistLifecycle|writeLifecycle|mutateLifecycle|updateRecoveryCase/i);
    }
  });
});
