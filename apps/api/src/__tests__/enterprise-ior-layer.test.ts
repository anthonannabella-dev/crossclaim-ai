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
