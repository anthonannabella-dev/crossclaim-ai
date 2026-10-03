/** P0-2 — Customer Qualification / Recovery Economics Gate 回归（确定性 + fail-closed）。 */

import { describe, expect, it } from 'vitest';

import {
  CUSTOMS_QUALIFICATION_BOUNDARY,
  CustomsQualificationError,
  computeCostRatio,
  evaluateCustomerQualification,
} from '../services/commercial/customer-qualification-gate';
import {
  IOR_QUALIFICATION_BOUNDARY,
  evaluateEnterpriseIorReadiness,
  toQualificationIorSummary,
} from '../services/customs/enterprise-ior/ior-qualification-readiness';
import { IOR_IDENTITY_BOUNDARY, normalizeIorIdentity } from '../services/customs/enterprise-ior/ior-identity';

const POLICY = {
  policyId: 'recovery-economics-2026',
  policyVersion: '1.0.0',
  currency: 'USD',
  minimumRecoveryThreshold: '100.00',
  highValueThreshold: '10000.00',
  maxCostRatio: '0.35',
  minimumDataCompleteness: '0.80',
};

const readiness = (overrides: Record<string, unknown> = {}) => ({
  organizationId: 'org-1',
  platformAccountId: 'acct-1',
  verifiedDataAvailable: true,
  importHistoryAvailable: true,
  returnExportDestructionEvidenceAvailable: true,
  lineageCompleteness: 'COMPLETE' as const,
  dataCompletenessScore: '0.95',
  riskLevel: 'LOW' as const,
  checkedAt: '2026-10-03T12:45:00.000Z',
  ...overrides,
});

const evaluate = (overrides: Record<string, unknown> = {}) =>
  evaluateCustomerQualification({
    readiness: readiness(),
    estimatedRecoveryAmount: '1000.00',
    estimatedExternalApiCost: '100.00',
    estimatedBrokerCost: '100.00',
    policy: POLICY,
    computedAt: '2026-10-03T12:45:00.000Z',
    ...overrides,
  } as never);

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof CustomsQualificationError ? error.code : 'NOT_A_QUALIFICATION_ERROR';
  }
  return 'NO_ERROR';
};

describe('P0-2 — customer qualification / recovery economics gate', () => {
  it('中等价值且成本占比达标 → QUALIFIED，且昂贵适配器才被允许', () => {
    const decision = evaluate();
    expect(decision.qualificationStatus).toBe('QUALIFIED');
    expect(decision.reasonCodes).toEqual(['OK']);
    expect(decision.expectedNetRecovery).toBe('800.000000');
    expect(decision.costRatio).toBe('0.200000');
    expect(decision.expensiveAdapterCallAllowed).toBe(true);
    expect(decision.filingAuthorized).toBe(false);
    expect(decision.transportEnabled).toBe(false);
  });

  it('高价值 → CONDITIONAL（需人工确认），不允许自动昂贵调用', () => {
    const decision = evaluate({ estimatedRecoveryAmount: '50000.00' });
    expect(decision.qualificationStatus).toBe('CONDITIONAL');
    expect(decision.reasonCodes).toContain('HIGH_VALUE_REQUIRES_CONFIRMATION');
    expect(decision.requiredConfirmation).toBe(true);
    expect(decision.expensiveAdapterCallAllowed).toBe(false);
  });

  it('低于最小阈值 / 无追回估算 → NOT_QUALIFIED（只出免费报告）', () => {
    const low = evaluate({ estimatedRecoveryAmount: '50.00' });
    expect(low.qualificationStatus).toBe('NOT_QUALIFIED');
    expect(low.reasonCodes).toContain('LOW_VALUE_BELOW_THRESHOLD');
    expect(low.advisoryOnly).toBe(true);

    const zero = evaluate({ estimatedRecoveryAmount: '0.00' });
    expect(zero.qualificationStatus).toBe('NOT_QUALIFIED');
    expect(zero.reasonCodes).toContain('NO_RECOVERY_ESTIMATE');
  });

  it('成本占比超过政策上限 → NOT_QUALIFIED（不允许自动追回）', () => {
    const decision = evaluate({ estimatedExternalApiCost: '300.00', estimatedBrokerCost: '200.00' });
    expect(decision.qualificationStatus).toBe('NOT_QUALIFIED');
    expect(decision.reasonCodes).toContain('COST_RATIO_EXCEEDED');
    expect(decision.expensiveAdapterCallAllowed).toBe(false);
  });

  it('净值为负 → NOT_QUALIFIED（NEGATIVE_NET_RECOVERY）', () => {
    const decision = evaluate({ estimatedRecoveryAmount: '150.00', estimatedExternalApiCost: '100.00', estimatedBrokerCost: '100.00', policy: { ...POLICY, maxCostRatio: '2.00' } });
    expect(decision.expectedNetRecovery.startsWith('-')).toBe(true);
    expect(decision.qualificationStatus).toBe('NOT_QUALIFIED');
    expect(decision.reasonCodes).toContain('NEGATIVE_NET_RECOVERY');
  });

  it('数据不足 / 完整度低于政策下限 → INDETERMINATE，绝不触发昂贵调用', () => {
    const noEvidence = evaluate({ readiness: readiness({ returnExportDestructionEvidenceAvailable: false }) });
    expect(noEvidence.qualificationStatus).toBe('INDETERMINATE');
    expect(noEvidence.reasonCodes).toContain('INCOMPLETE_DATA');
    expect(noEvidence.expensiveAdapterCallAllowed).toBe(false);

    const lowScore = evaluate({ readiness: readiness({ dataCompletenessScore: '0.50' }) });
    expect(lowScore.qualificationStatus).toBe('INDETERMINATE');
  });

  it('lineage 不完整（PARTIAL / AMBIGUOUS）→ INDETERMINATE（不自动追回）', () => {
    for (const completeness of ['PARTIAL', 'AMBIGUOUS'] as const) {
      const decision = evaluate({ readiness: readiness({ lineageCompleteness: completeness }) });
      expect(decision.qualificationStatus).toBe('INDETERMINATE');
      expect(decision.reasonCodes).toContain('AMBIGUOUS_LINEAGE');
    }
  });

  it('确定性 + 政策版本变化 → 结论改变（可审计版本）', () => {
    const first = evaluate();
    const second = evaluate();
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    const stricter = evaluate({ policy: { ...POLICY, policyVersion: '1.1.0', maxCostRatio: '0.10' } });
    expect(stricter.qualificationStatus).toBe('NOT_QUALIFIED');
    expect(stricter.policyVersion).toBe('1.1.0');
    expect(first.policyVersion).toBe('1.0.0');
  });

  it('非法输入 fail-closed：金额 / 政策 / readiness', () => {
    expect(codeOf(() => evaluate({ estimatedRecoveryAmount: 'abc' }))).toBe('INVALID_AMOUNT');
    expect(codeOf(() => evaluate({ policy: null }))).toBe('INVALID_POLICY');
    expect(codeOf(() => evaluate({ readiness: null }))).toBe('INVALID_REQUEST');
    expect(codeOf(() => evaluate({ readiness: readiness({ lineageCompleteness: 'GUESS' }) }))).toBe('INVALID_REQUEST');
  });

  it('成本占比工具：recovery<=0 → null；等值边界按十进制精确比较', () => {
    expect(computeCostRatio('0.00', '0.00', '0.00')).toBeNull();
    expect(computeCostRatio('100.00', '0.00', '1000.00')).toBe('0.100000');
    const edge = evaluate({ estimatedExternalApiCost: '350.00', estimatedBrokerCost: '0.00' });
    expect(edge.costRatio).toBe('0.350000');
    expect(edge.qualificationStatus).toBe('QUALIFIED');
  });

  it('边界常量：昂贵调用受 gate 控制，判定 ≠ filing 授权', () => {
    expect(CUSTOMS_QUALIFICATION_BOUNDARY.gatesExpensiveAdapters).toBe(true);
    expect(CUSTOMS_QUALIFICATION_BOUNDARY.autoExternalCallWhenNotQualified).toBe(false);
    expect(CUSTOMS_QUALIFICATION_BOUNDARY.indeterminateTriggersExternalCall).toBe(false);
    expect(CUSTOMS_QUALIFICATION_BOUNDARY.conditionalRequiresHumanConfirmation).toBe(true);
    expect(CUSTOMS_QUALIFICATION_BOUNDARY.filingAuthorized).toBe(false);
    expect(CUSTOMS_QUALIFICATION_BOUNDARY.transportEnabled).toBe(false);
    expect(CUSTOMS_QUALIFICATION_BOUNDARY.productionCredentials).toBe('ABSENT');
  });
});

// ---- BG-014：ENTERPRISE IOR readiness 接入既有 Qualification Gate（复用，不建第二套引擎）----

const IOR_NOW = '2026-10-03T12:45:00.000Z';

const iorIdentity = (overrides: Record<string, unknown> = {}) =>
  normalizeIorIdentity({
    organizationId: 'org-1',
    jurisdiction: 'US',
    principalType: 'IMPORTER_OF_RECORD',
    importerOfRecordRef: 'ior_acct_1',
    legalEntityRef: 'legal_entity_1',
    aceAccountRef: 'ace:acct:1',
    verificationStatus: 'VERIFIED',
    verificationSource: 'ACE_LOOKUP',
    verifiedAt: '2026-09-01T00:00:00.000Z',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
    ...overrides,
  } as never);

const IOR_DEADLINE_POLICY = [
  {
    policyId: 'customs-remedy-deadline-2026',
    policyVersion: '1.0.0',
    jurisdiction: 'US',
    remedy: 'DRAWBACK' as const,
    anchorField: 'exportDate' as const,
    daysFromAnchor: 1825,
  },
];

const iorReadinessInput = (overrides: Record<string, unknown> = {}) => ({
  identity: iorIdentity(),
  rightLineage: {
    organizationId: 'org-1',
    entryReference: 'entry:1',
    importerOfRecordRef: 'ior_acct_1',
    claimantRef: 'claimant:1',
    remedyRoute: 'DRAWBACK',
    iorVerified: true,
    iorRightsForRemedy: 'CONFIRMED' as const,
    claimantRightsForRemedy: 'CONFIRMED' as const,
    filingAuthorized: true,
    evidence: ['ENTRY_RECORD', 'IOR_VERIFICATION', 'CLAIMANT_ATTESTATION', 'RECOVERY_RIGHT_DOCUMENT', 'FILING_AUTHORIZATION'].map(
      (kind) => ({ kind, reference: 'ref-1', digest: null }),
    ),
  },
  brokerAuthorization: {
    organizationId: 'org-1',
    principalRef: 'ior_acct_1',
    brokerRef: 'broker:1',
    jurisdiction: 'US',
    authorizationType: 'CBP_FORM_5291',
    scope: ['DRAWBACK'],
    effectiveAt: '2026-01-01T00:00:00.000Z',
    expiresAt: null,
    evidenceArtifactRef: 'poa:1',
    verificationStatus: 'VERIFIED',
    verificationSource: 'MANUAL_REVIEW',
  },
  remedyDeadline: {
    jurisdiction: 'US',
    remedy: 'DRAWBACK',
    entryDate: '2025-01-01',
    liquidationDate: '2025-03-01',
    exportDate: '2026-01-01',
    destructionDate: null,
    exclusionEffectiveDate: null,
  },
  deadlinePolicies: IOR_DEADLINE_POLICY,
  refundDestination: {
    organizationId: 'org-1',
    claimantRef: 'claimant:1',
    payeeIdentityConfirmed: true,
    aceRefundEnrollmentStatus: 'READY' as const,
    refundDestinationVerified: true,
    thirdPartyDesignationPresent: false,
    verifiedAt: '2026-09-01T00:00:00.000Z',
    bankAccountReference: null,
  },
  now: IOR_NOW,
  ...overrides,
});

describe('BG-014 — Enterprise IOR readiness 接入既有 Qualification Gate', () => {
  it('IOR 全就绪 → 与既有经济学路径一致（QUALIFIED），并标记已评估', () => {
    const readiness = evaluateEnterpriseIorReadiness(iorReadinessInput() as never);
    expect(readiness.ready).toBe(true);
    expect(readiness.reasonCodes).toEqual(['OK']);
    expect(readiness.terminal).toBe(false);
    expect(readiness.callsExpensiveProvider).toBe(false);
    expect(readiness.autoFilingAllowed).toBe(false);

    const decision = evaluate({ iorReadiness: toQualificationIorSummary(readiness) });
    expect(decision.qualificationStatus).toBe('QUALIFIED');
    expect(decision.iorReadinessEvaluated).toBe(true);
    expect(decision.iorReady).toBe(true);
    expect(decision.iorReasonCodes).toEqual(['OK']);
    expect(decision.expensiveAdapterCallAllowed).toBe(true);
  });

  it('未提供 IOR readiness → 既有行为完全不变（向后兼容）', () => {
    const decision = evaluate();
    expect(decision.qualificationStatus).toBe('QUALIFIED');
    expect(decision.iorReadinessEvaluated).toBe(false);
    expect(decision.iorReady).toBe(false);
    expect(decision.iorReasonCodes).toEqual([]);
  });

  it('权利链不清 / POA 缺失 / refund destination 未就绪 → INDETERMINATE + IOR_NOT_READY（不触发昂贵调用）', () => {
    const base = iorReadinessInput();
    const unclear = evaluateEnterpriseIorReadiness(
      iorReadinessInput({
        rightLineage: { ...(base.rightLineage as object), iorRightsForRemedy: 'UNCLEAR' },
      }) as never,
    );
    expect(unclear.ready).toBe(false);
    expect(unclear.reasonCodes).toContain('RIGHT_LINEAGE_NEEDS_MANUAL');

    const decision = evaluate({ iorReadiness: toQualificationIorSummary(unclear) });
    expect(decision.qualificationStatus).toBe('INDETERMINATE');
    expect(decision.reasonCodes).toContain('IOR_NOT_READY');
    expect(decision.expensiveAdapterCallAllowed).toBe(false);
    expect(decision.advisoryOnly).toBe(true);
    expect(decision.filingAuthorized).toBe(false);

    const noPoa = evaluateEnterpriseIorReadiness(iorReadinessInput({ brokerAuthorization: null }) as never);
    expect(noPoa.reasonCodes).toContain('BROKER_AUTHORIZATION_MISSING');
    expect(evaluate({ iorReadiness: toQualificationIorSummary(noPoa) }).qualificationStatus).toBe('INDETERMINATE');

    const noRefund = evaluateEnterpriseIorReadiness(iorReadinessInput({ refundDestination: null }) as never);
    expect(noRefund.reasonCodes).toContain('REFUND_DESTINATION_NOT_READY');
    expect(noRefund.ready).toBe(false);
  });

  it('remedy deadline 已过期 → 终局 NOT_QUALIFIED（IOR_DEADLINE_EXPIRED）', () => {
    const expired = evaluateEnterpriseIorReadiness(
      iorReadinessInput({
        remedyDeadline: {
          jurisdiction: 'US',
          remedy: 'DRAWBACK',
          entryDate: '2019-01-01',
          liquidationDate: '2019-03-01',
          exportDate: '2019-01-01',
          destructionDate: null,
          exclusionEffectiveDate: null,
        },
      }) as never,
    );
    expect(expired.remedyDeadlineStatus).toBe('EXPIRED');
    expect(expired.terminal).toBe(true);
    expect(expired.ready).toBe(false);

    const decision = evaluate({ iorReadiness: toQualificationIorSummary(expired) });
    expect(decision.qualificationStatus).toBe('NOT_QUALIFIED');
    expect(decision.reasonCodes).toContain('IOR_DEADLINE_EXPIRED');
    expect(decision.advisoryOnly).toBe(true);
    expect(decision.expensiveAdapterCallAllowed).toBe(false);
  });

  it('remedy deadline 缺 policy / 缺 anchor → INDETERMINATE（非终局），不调用昂贵 provider', () => {
    const indeterminate = evaluateEnterpriseIorReadiness(
      iorReadinessInput({
        remedyDeadline: {
          jurisdiction: 'US',
          remedy: 'PROTEST',
          entryDate: '2025-01-01',
          liquidationDate: null,
          exportDate: null,
          destructionDate: null,
          exclusionEffectiveDate: null,
        },
      }) as never,
    );
    expect(indeterminate.remedyDeadlineStatus).toBe('INDETERMINATE');
    expect(indeterminate.terminal).toBe(false);
    expect(indeterminate.reasonCodes).toContain('REMEDY_DEADLINE_INDETERMINATE');

    const decision = evaluate({ iorReadiness: toQualificationIorSummary(indeterminate) });
    expect(decision.qualificationStatus).toBe('INDETERMINATE');
    expect(decision.reasonCodes).toContain('IOR_NOT_READY');
  });

  it('边界常量：IOR readiness 参与 gate，但不改变「判定 ≠ filing 授权」', () => {
    expect(CUSTOMS_QUALIFICATION_BOUNDARY.iorReadinessGatesQualification).toBe(true);
    expect(IOR_QUALIFICATION_BOUNDARY.reusesExistingQualificationGate).toBe(true);
    expect(IOR_QUALIFICATION_BOUNDARY.secondQualificationEngine).toBe(false);
    expect(IOR_QUALIFICATION_BOUNDARY.autoFilingAllowed).toBe(false);
    expect(IOR_QUALIFICATION_BOUNDARY.productionCredentials).toBe('ABSENT');
    expect(IOR_IDENTITY_BOUNDARY.clientReportedTruthAccepted).toBe(false);
  });
});
