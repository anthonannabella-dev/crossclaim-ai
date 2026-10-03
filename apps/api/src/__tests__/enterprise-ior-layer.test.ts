/** ENTERPRISE IOR RECOVERY LAYER — 契约层回归（identity / right lineage / broker POA / remedy deadline / evidence taxonomy / refund destination）。 */

import { describe, expect, it } from 'vitest';

import {
  IOR_IDENTITY_BOUNDARY,
  IorContractError,
  evaluateIorIdentity,
  normalizeIorIdentity,
} from '../services/customs/enterprise-ior/ior-identity';
import { RIGHT_LINEAGE_BOUNDARY, evaluateRightLineage } from '../services/customs/enterprise-ior/right-lineage';
import { BROKER_POA_BOUNDARY, evaluateBrokerAuthorization } from '../services/customs/enterprise-ior/broker-poa';
import { REMEDY_DEADLINE_BOUNDARY, evaluateRemedyDeadline } from '../services/customs/enterprise-ior/remedy-deadline';
import {
  CustomsEvidenceTaxonomyError,
  normalizeEvidenceReference,
} from '../services/customs/enterprise-ior/evidence-taxonomy';
import { REFUND_DESTINATION_BOUNDARY, evaluateRefundDestinationReadiness } from '../services/customs/enterprise-ior/refund-destination';
import {
  evaluateEnterpriseIorReadiness,
  toQualificationIorSummary,
} from '../services/customs/enterprise-ior/ior-qualification-readiness';
import {
  IOR_CHAIN_BOUNDARY,
  IOR_CHAIN_STAGES,
  evaluateIorRecoveryChain,
} from '../services/customs/enterprise-ior/ior-recovery-chain';

const ORG = 'org-1';
const NOW = '2026-10-03T00:00:00.000Z';

const identity = (overrides: Record<string, unknown> = {}) => ({
  organizationId: ORG,
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
});

describe('Enterprise IOR layer — contracts', () => {
  it('IOR identity：VERIFIED + legal entity → usable；UNVERIFIED / REVOKED / 过期 → 不可用（fail-closed）', () => {
    const good = normalizeIorIdentity(identity() as never);
    expect(evaluateIorIdentity(good, NOW).usable).toBe(true);

    const pending = normalizeIorIdentity(identity({ verificationStatus: 'PENDING' }) as never);
    expect(evaluateIorIdentity(pending, NOW).reasonCodes).toContain('UNVERIFIED_IDENTITY');
    const revoked = normalizeIorIdentity(identity({ verificationStatus: 'REVOKED' }) as never);
    expect(evaluateIorIdentity(revoked, NOW).reasonCodes).toContain('REVOKED_IDENTITY');
    const expired = normalizeIorIdentity(identity({ effectiveTo: '2026-01-01T00:00:00.000Z' }) as never);
    expect(evaluateIorIdentity(expired, NOW).reasonCodes).toContain('OUT_OF_EFFECTIVE_WINDOW');
  });

  it('IOR identity：客户端自报 truth 与裸敏感值（EIN / importer number / bank / credential）一律拒绝', () => {
    expect(() => normalizeIorIdentity(identity() as never, { clientReported: true })).toThrow(IorContractError);
    expect(() => normalizeIorIdentity(identity({ ein: '12-3456789' }) as never)).toThrow(IorContractError);
    expect(() => normalizeIorIdentity(identity({ importerNumber: '1234567' }) as never)).toThrow(IorContractError);
    expect(() => normalizeIorIdentity(identity({ bankAccount: '123456789012' }) as never)).toThrow(IorContractError);
    expect(() => normalizeIorIdentity(identity({ credential: 'x' }) as never)).toThrow(IorContractError);
    expect(IOR_IDENTITY_BOUNDARY.clientReportedTruthAccepted).toBe(false);
    expect(IOR_IDENTITY_BOUNDARY.rawSensitiveValuesStored).toBe(false);
  });

  it('Right lineage：证据齐备 + 权利确认 → COMPLETE，但 autoFilingAllowed 恒 false', () => {
    const result = evaluateRightLineage({
      organizationId: ORG,
      entryReference: 'entry-1',
      importerOfRecordRef: 'ior_acct_1',
      claimantRef: 'claimant-1',
      remedyRoute: 'DRAWBACK',
      iorVerified: true,
      iorRightsForRemedy: 'CONFIRMED',
      claimantRightsForRemedy: 'CONFIRMED',
      filingAuthorized: true,
      evidence: [
        { kind: 'ENTRY_RECORD', reference: 'e1', digest: null },
        { kind: 'IOR_VERIFICATION', reference: 'v1', digest: null },
        { kind: 'CLAIMANT_ATTESTATION', reference: 'c1', digest: null },
        { kind: 'RECOVERY_RIGHT_DOCUMENT', reference: 'r1', digest: null },
        { kind: 'FILING_AUTHORIZATION', reference: 'f1', digest: null },
      ],
    });
    expect(result.outcome).toBe('COMPLETE');
    expect(result.autoFilingAllowed).toBe(false);
    expect(RIGHT_LINEAGE_BOUNDARY.iorImpliesClaimant).toBe(false);
  });

  it('Right lineage：权利不明确 / 证据缺失 → BROKER_REVIEW 或 NEEDS_MANUAL（不自动 filing）', () => {
    const unclear = evaluateRightLineage({
      organizationId: ORG,
      entryReference: 'entry-1',
      importerOfRecordRef: 'ior_acct_1',
      claimantRef: 'claimant-1',
      remedyRoute: 'PROTEST',
      iorVerified: true,
      iorRightsForRemedy: 'UNCLEAR',
      claimantRightsForRemedy: 'CONFIRMED',
      filingAuthorized: true,
      evidence: [],
    });
    expect(unclear.outcome).toBe('BROKER_REVIEW');
    expect(unclear.reasonCodes).toContain('IOR_RIGHTS_UNCLEAR');

    const missingIor = evaluateRightLineage({
      organizationId: ORG,
      entryReference: 'entry-1',
      importerOfRecordRef: 'ior_acct_1',
      claimantRef: 'claimant-1',
      remedyRoute: 'DRAWBACK',
      iorVerified: false,
      iorRightsForRemedy: 'CONFIRMED',
      claimantRightsForRemedy: 'CONFIRMED',
      filingAuthorized: true,
      evidence: [],
    });
    // 证据缺失同样进入 unclear-rights 分支：NEEDS_MANUAL / BROKER_REVIEW 都属于 fail-closed 结果。
    expect(['NEEDS_MANUAL', 'BROKER_REVIEW']).toContain(missingIor.outcome);
    expect(missingIor.autoFilingAllowed).toBe(false);
    expect(missingIor.reasonCodes).toContain('IOR_NOT_VERIFIED');
  });

  it('Broker POA：5291 + 证据 + VERIFIED → usable；4811 / OAuth / Payment 混淆 → 拒绝', () => {
    const good = evaluateBrokerAuthorization(
      {
        organizationId: ORG,
        principalRef: 'ior_acct_1',
        brokerRef: 'broker-1',
        jurisdiction: 'US',
        authorizationType: 'CBP_FORM_5291',
        scope: ['ENTRY_FILING', 'REFUND_CLAIM'],
        effectiveAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2027-01-01T00:00:00.000Z',
        evidenceArtifactRef: 'poa:artifact:1',
        verificationStatus: 'VERIFIED',
        verificationSource: 'BROKER_ATTESTATION',
      },
      NOW,
    );
    expect(good.usable).toBe(true);
    expect(good.form4811UsedAsBrokerPoa).toBe(false);

    const wrongForm = evaluateBrokerAuthorization(
      {
        organizationId: ORG,
        principalRef: 'ior_acct_1',
        brokerRef: 'broker-1',
        jurisdiction: 'US',
        authorizationType: 'CBP_FORM_4811',
        scope: ['ENTRY_FILING'],
        effectiveAt: '2026-01-01T00:00:00.000Z',
        expiresAt: null,
        evidenceArtifactRef: 'poa:artifact:1',
        verificationStatus: 'VERIFIED',
        verificationSource: 'BROKER_ATTESTATION',
      },
      NOW,
    );
    expect(wrongForm.usable).toBe(false);
    expect(wrongForm.reasonCodes).toContain('WRONG_AUTHORIZATION_TYPE');
    expect(BROKER_POA_BOUNDARY.form4811AllowedForBrokerPoa).toBe(false);
    expect(BROKER_POA_BOUNDARY.platformOAuthIsBrokerPoa).toBe(false);
    expect(BROKER_POA_BOUNDARY.paymentAuthorizationIsBrokerPoa).toBe(false);
  });

  it('Remedy deadline：按 policy 计算；缺 anchor → INDETERMINATE 且不调用昂贵 provider', () => {
    const policies = [
      {
        policyId: 'us-remedy-2026',
        policyVersion: '1.0.0',
        jurisdiction: 'US',
        remedy: 'DRAWBACK' as const,
        anchorField: 'exportDate' as const,
        daysFromAnchor: 365,
      },
    ];
    const eligible = evaluateRemedyDeadline(
      { jurisdiction: 'US', remedy: 'DRAWBACK', entryDate: '2026-01-01', liquidationDate: null, exportDate: '2026-06-01', destructionDate: null, exclusionEffectiveDate: null },
      policies,
      NOW,
    );
    expect(eligible.status).toBe('ELIGIBLE_WINDOW');
    expect(eligible.deadline).toBe('2027-06-01');
    expect(eligible.policyVersion).toBe('1.0.0');

    const indeterminate = evaluateRemedyDeadline(
      { jurisdiction: 'US', remedy: 'DRAWBACK', entryDate: '2026-01-01', liquidationDate: null, exportDate: null, destructionDate: null, exclusionEffectiveDate: null },
      policies,
      NOW,
    );
    expect(indeterminate.status).toBe('INDETERMINATE');
    expect(indeterminate.reasonCodes.join(',')).toContain('MISSING_ANCHOR_DATE');
    expect(indeterminate.callsExpensiveProvider).toBe(false);
    expect(indeterminate.autoFilingAllowed).toBe(false);

    const noPolicy = evaluateRemedyDeadline(
      { jurisdiction: 'CA', remedy: 'PROTEST', entryDate: '2026-01-01', liquidationDate: null, exportDate: null, destructionDate: null, exclusionEffectiveDate: null },
      policies,
      NOW,
    );
    expect(noPolicy.status).toBe('INDETERMINATE');
    expect(REMEDY_DEADLINE_BOUNDARY.globalThreeToFiveYearRule).toBe(false);
  });

  it('Evidence taxonomy：正式类型 + safe reference + digest 校验', () => {
    const ok = normalizeEvidenceReference({ kind: 'cbp_7501', reference: 'artifact:7501:1', digest: 'a'.repeat(64), observedAt: NOW });
    expect(ok.kind).toBe('CBP_7501');
    expect(() => normalizeEvidenceReference({ kind: 'CBP_4811', reference: 'x', digest: null, observedAt: null })).toThrow(CustomsEvidenceTaxonomyError);
    expect(() => normalizeEvidenceReference({ kind: 'CBP_7501', reference: 'has space', digest: null, observedAt: null })).toThrow(CustomsEvidenceTaxonomyError);
    expect(() => normalizeEvidenceReference({ kind: 'CBP_7501', reference: 'ok', digest: 'not-hex', observedAt: null })).toThrow(CustomsEvidenceTaxonomyError);
  });

  it('Refund destination：readiness 只读；APPROVED≠PAID、estimated≠fee basis、不存银行原文', () => {
    const ready = evaluateRefundDestinationReadiness({
      organizationId: ORG,
      claimantRef: 'claimant-1',
      payeeIdentityConfirmed: true,
      aceRefundEnrollmentStatus: 'READY',
      refundDestinationVerified: true,
      thirdPartyDesignationPresent: false,
      verifiedAt: NOW,
      bankAccountReference: 'bank-token-ref-1',
    });
    expect(ready.ready).toBe(true);
    expect(ready.collectsRefund).toBe(false);
    expect(ready.approvedIsPaid).toBe(false);
    expect(ready.estimatedIsFeeBasis).toBe(false);

    const rawBank = evaluateRefundDestinationReadiness({
      organizationId: ORG,
      claimantRef: 'claimant-1',
      payeeIdentityConfirmed: true,
      aceRefundEnrollmentStatus: 'READY',
      refundDestinationVerified: true,
      thirdPartyDesignationPresent: false,
      verifiedAt: NOW,
      bankAccountReference: '123456789012',
    });
    expect(rawBank.ready).toBe(false);
    expect(rawBank.reasonCodes).toContain('RAW_BANK_ACCOUNT_NOT_ALLOWED');
    expect(REFUND_DESTINATION_BOUNDARY.crossclaimCollectsRefund).toBe(false);
    expect(REFUND_DESTINATION_BOUNDARY.requiresVerifiedReceiptBeforeSettlement).toBe(true);
  });
});

// ---- BG-014：⑥ 聚集就绪（qualification readiness aggregate）----

const readinessInput = (overrides: Record<string, unknown> = {}) => ({
  identity: identity() as never,
  rightLineage: {
    organizationId: ORG,
    entryReference: 'entry:1',
    importerOfRecordRef: 'ior_acct_1',
    claimantRef: 'claimant:1',
    remedyRoute: 'DRAWBACK',
    iorVerified: true,
    iorRightsForRemedy: 'CONFIRMED',
    claimantRightsForRemedy: 'CONFIRMED',
    filingAuthorized: true,
    evidence: ['ENTRY_RECORD', 'IOR_VERIFICATION', 'CLAIMANT_ATTESTATION', 'RECOVERY_RIGHT_DOCUMENT', 'FILING_AUTHORIZATION'].map(
      (kind) => ({ kind, reference: 'ref-1', digest: null }),
    ),
  },
  brokerAuthorization: {
    organizationId: ORG,
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
  deadlinePolicies: [
    { policyId: 'p-1', policyVersion: '1.0.0', jurisdiction: 'US', remedy: 'DRAWBACK', anchorField: 'exportDate', daysFromAnchor: 1825 },
  ],
  refundDestination: {
    organizationId: ORG,
    claimantRef: 'claimant:1',
    payeeIdentityConfirmed: true,
    aceRefundEnrollmentStatus: 'READY',
    refundDestinationVerified: true,
    thirdPartyDesignationPresent: false,
    verifiedAt: NOW,
    bankAccountReference: null,
  },
  now: NOW,
  ...overrides,
});

describe('Enterprise IOR layer — ⑥ qualification readiness aggregate', () => {
  it('全就绪 → ready=true / OK；只读、不调用昂贵 provider、不自动 filing', () => {
    const result = evaluateEnterpriseIorReadiness(readinessInput() as never);
    expect(result.ready).toBe(true);
    expect(result.reasonCodes).toEqual(['OK']);
    expect(result.callsExpensiveProvider).toBe(false);
    expect(result.autoFilingAllowed).toBe(false);
    expect(result.readOnly).toBe(true);
    expect(result.rightLineage).toBe('COMPLETE');
    expect(result.remedyDeadlineStatus).toBe('ELIGIBLE_WINDOW');

    const summary = toQualificationIorSummary(result);
    expect(summary).toEqual({ ready: true, terminal: false, reasonCodes: ['OK'] });
  });

  it('未验证 IOR / 4811 当 POA / 裸银行账号 → 不可就绪（fail-closed）', () => {
    const unverified = evaluateEnterpriseIorReadiness(
      readinessInput({ identity: identity({ verificationStatus: 'UNVERIFIED' }) }) as never,
    );
    expect(unverified.ready).toBe(false);
    expect(unverified.reasonCodes).toContain('IOR_IDENTITY_UNUSABLE');

    const base = readinessInput();
    const wrongPoa = evaluateEnterpriseIorReadiness(
      readinessInput({
        brokerAuthorization: { ...(base.brokerAuthorization as object), authorizationType: 'CBP_FORM_4811' },
      }) as never,
    );
    expect(wrongPoa.ready).toBe(false);
    expect(wrongPoa.reasonCodes).toContain('BROKER_AUTHORIZATION_NOT_READY');

    const rawBank = evaluateEnterpriseIorReadiness(
      readinessInput({
        refundDestination: { ...(base.refundDestination as object), bankAccountReference: '1234567890' },
      }) as never,
    );
    expect(rawBank.ready).toBe(false);
    expect(rawBank.reasonCodes).toContain('REFUND_DESTINATION_NOT_READY');
  });
});

// ---- BG-015：⑪ 全链装配（7501/Entry → … → claim-ready / filing-provider / refund destination；零外写）----

const CHAIN_NOW = '2026-10-03T12:45:00.000Z';

const CHAIN_CUSTOMER_READINESS = {
  organizationId: ORG,
  platformAccountId: 'acct-1',
  verifiedDataAvailable: true,
  importHistoryAvailable: true,
  returnExportDestructionEvidenceAvailable: true,
  lineageCompleteness: 'COMPLETE' as const,
  dataCompletenessScore: '0.95',
  riskLevel: 'LOW' as const,
  checkedAt: CHAIN_NOW,
};

const CHAIN_POLICY = {
  policyId: 'recovery-economics-2026',
  policyVersion: '1.0.0',
  currency: 'USD',
  minimumRecoveryThreshold: '100.00',
  highValueThreshold: '10000.00',
  maxCostRatio: '0.35',
  minimumDataCompleteness: '0.80',
};

const CHAIN_DEADLINE_POLICIES = [
  { policyId: 'p-1', policyVersion: '1.0.0', jurisdiction: 'US', remedy: 'DRAWBACK', anchorField: 'exportDate', daysFromAnchor: 1825 },
];

const CHAIN_EVIDENCE = [
  { kind: 'CBP_7501', reference: 'cbp:7501:1', digest: null, observedAt: CHAIN_NOW },
  { kind: 'DUTY_PAYMENT_RECORD', reference: 'duty:1', digest: null, observedAt: CHAIN_NOW },
  { kind: 'EXPORT_RECORD', reference: 'export:1', digest: null, observedAt: CHAIN_NOW },
];

const chainInput = (overrides: Record<string, unknown> = {}) => ({
  organizationId: ORG,
  entryReference: 'entry:1',
  identity: identity() as never,
  rightLineage: {
    organizationId: ORG,
    entryReference: 'entry:1',
    importerOfRecordRef: 'ior_acct_1',
    claimantRef: 'claimant:1',
    remedyRoute: 'DRAWBACK',
    iorVerified: true,
    iorRightsForRemedy: 'CONFIRMED',
    claimantRightsForRemedy: 'CONFIRMED',
    filingAuthorized: true,
    evidence: ['ENTRY_RECORD', 'IOR_VERIFICATION', 'CLAIMANT_ATTESTATION', 'RECOVERY_RIGHT_DOCUMENT', 'FILING_AUTHORIZATION'].map(
      (kind) => ({ kind, reference: 'ref-1', digest: null }),
    ),
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
  deadlinePolicies: CHAIN_DEADLINE_POLICIES,
  brokerAuthorization: {
    organizationId: ORG,
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
  refundDestination: {
    organizationId: ORG,
    claimantRef: 'claimant:1',
    payeeIdentityConfirmed: true,
    aceRefundEnrollmentStatus: 'READY',
    refundDestinationVerified: true,
    thirdPartyDesignationPresent: false,
    verifiedAt: CHAIN_NOW,
    bankAccountReference: null,
  },
  evidence: CHAIN_EVIDENCE,
  customerReadiness: CHAIN_CUSTOMER_READINESS,
  estimatedRecoveryAmount: '1000.00',
  estimatedExternalApiCost: '100.00',
  estimatedBrokerCost: '100.00',
  policy: CHAIN_POLICY,
  filingProvider: { providerId: 'abi-provider:1', filingCapabilityEnabled: false, credentialPresent: false },
  now: CHAIN_NOW,
  ...overrides,
});

const stageOf = (
  result: { stages: readonly { stage: string; status: string; reasonCodes: readonly string[] }[] },
  stageName: string,
) => result.stages.find((item) => item.stage === stageName);

describe('BG-015 — Enterprise IOR 全链装配（fail-closed / 零外写）', () => {
  it('内部全链就绪但 filing provider 属 HOLD_EXTERNAL → claimPackageReady=true / filingReady=false / autoSubmit=false', () => {
    const result = evaluateIorRecoveryChain(chainInput() as never);
    expect(result.claimPackageReady).toBe(true);
    expect(stageOf(result, 'CLAIM_READY')?.status).toBe('READY');
    expect(stageOf(result, 'FILING_PROVIDER_READINESS')?.status).toBe('NOT_READY');
    expect(stageOf(result, 'FILING_PROVIDER_READINESS')?.reasonCodes).toEqual([
      'FILING_CAPABILITY_DISABLED',
      'PRODUCTION_CREDENTIALS_ABSENT',
    ]);
    expect(result.filingReady).toBe(false);
    expect(result.autoSubmitAllowed).toBe(false);
    expect(result.filingSubmitted).toBe(false);
    expect(result.externalWritePerformed).toBe(false);
    expect(result.transportEnabled).toBe(false);
    expect(result.productionCredentials).toBe('ABSENT');
    expect(result.stages).toHaveLength(IOR_CHAIN_STAGES.length);
  });

  it('权利链不明确 → RIGHT_LINEAGE=INDETERMINATE（BROKER_REVIEW），claimPackageReady=false', () => {
    const base = chainInput();
    const result = evaluateIorRecoveryChain(
      chainInput({ rightLineage: { ...(base.rightLineage as object), iorRightsForRemedy: 'UNCLEAR' } }) as never,
    );
    expect(stageOf(result, 'RIGHT_LINEAGE')?.status).toBe('INDETERMINATE');
    expect(stageOf(result, 'RIGHT_LINEAGE')?.reasonCodes).toContain('IOR_RIGHTS_UNCLEAR');
    expect(result.claimPackageReady).toBe(false);
    expect(stageOf(result, 'CLAIM_READY')?.status).toBe('NOT_READY');
  });

  it('remedy deadline 已过 → EXPIRED（终局），且 qualification 落 NOT_QUALIFIED', () => {
    const result = evaluateIorRecoveryChain(
      chainInput({
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
    expect(stageOf(result, 'REMEDY_DEADLINE')?.status).toBe('EXPIRED');
    expect(stageOf(result, 'QUALIFICATION')?.status).toBe('NOT_READY');
    expect(result.qualification.qualificationStatus).toBe('NOT_QUALIFIED');
    expect(result.claimPackageReady).toBe(false);
  });

  it('证据引用不安全 / 未知类型 → EVIDENCE=BLOCKED（fail-closed，不静默丢弃）', () => {
    const unsafe = evaluateIorRecoveryChain(
      chainInput({ evidence: [{ kind: 'CBP_7501', reference: 'John Doe SSN 123-45-6789', digest: null, observedAt: CHAIN_NOW }] }) as never,
    );
    expect(stageOf(unsafe, 'EVIDENCE')?.status).toBe('BLOCKED');
    expect(stageOf(unsafe, 'EVIDENCE')?.reasonCodes).toEqual(['UNSAFE_REFERENCE']);
    expect(unsafe.claimPackageReady).toBe(false);

    const unknownKind = evaluateIorRecoveryChain(
      chainInput({ evidence: [{ kind: 'NOT_A_KIND', reference: 'ref-1', digest: null, observedAt: CHAIN_NOW }] }) as never,
    );
    expect(stageOf(unknownKind, 'EVIDENCE')?.status).toBe('BLOCKED');
    expect(stageOf(unknownKind, 'EVIDENCE')?.reasonCodes).toEqual(['UNKNOWN_EVIDENCE_KIND']);
  });

  it('裸银行账号 → REFUND_DESTINATION_READINESS=NOT_READY（不存原文、不代收）', () => {
    const base = chainInput();
    const result = evaluateIorRecoveryChain(
      chainInput({ refundDestination: { ...(base.refundDestination as object), bankAccountReference: '123456789012' } }) as never,
    );
    expect(stageOf(result, 'REFUND_DESTINATION_READINESS')?.status).toBe('NOT_READY');
    expect(stageOf(result, 'REFUND_DESTINATION_READINESS')?.reasonCodes).toContain('RAW_BANK_ACCOUNT_NOT_ALLOWED');
    expect(result.claimPackageReady).toBe(false);
  });

  it('边界：即使宿主启用 filing capability，本层仍不自动提交（autoSubmitAllowed 恒 false）', () => {
    const result = evaluateIorRecoveryChain(
      chainInput({ filingProvider: { providerId: 'abi-provider:1', filingCapabilityEnabled: true, credentialPresent: true } }) as never,
    );
    expect(stageOf(result, 'FILING_PROVIDER_READINESS')?.status).toBe('READY');
    expect(result.filingReady).toBe(true);
    expect(result.autoSubmitAllowed).toBe(false);
    expect(IOR_CHAIN_BOUNDARY.autoSubmitAllowed).toBe(false);
    expect(IOR_CHAIN_BOUNDARY.productionCredentials).toBe('ABSENT');
  });
});
