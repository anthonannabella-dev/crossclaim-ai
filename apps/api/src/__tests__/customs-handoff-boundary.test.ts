/**
 * CUSTOMS GAP G4 / C7（Q3 PASS）— Handoff-Only 边界回归。
 */

import { describe, expect, it } from 'vitest';

import { normalizeCustomsEntryFact } from '../services/customs/customs-entry-contract';
import { computeCustomsDutyTruth } from '../services/customs/customs-duty-truth';
import { compareCustomsClassification } from '../services/customs/customs-classification-discrepancy';
import { evaluateCustomsEligibility } from '../services/customs/customs-recovery-eligibility';
import { estimateCustomsRecovery } from '../services/customs/customs-recovery-estimate';
import { assembleCustomsClaimReadyPackage } from '../services/customs/customs-claim-ready-package';
import {
  CUSTOMS_HANDOFF_FORBIDDEN_ACTIONS,
  CustomsHandoffError,
  buildCustomsHandoffArtifact,
  normalizeCustomsHandoffAcknowledgement,
} from '../services/customs/customs-handoff-boundary';

const AT = '2026-10-03T09:56:00.000Z';

function readyPackage(amount = '120.00', expectedAmount = '100.00') {
  const fact = normalizeCustomsEntryFact({
    entryNumber: 'ABI-2026-000123',
    entryDate: '2026-09-18',
    jurisdiction: 'US',
    portOfEntry: 'Los Angeles, CA',
    importerOfRecordRef: 'ior_acct_88213',
    source: 'ABI_VENDOR',
    rawReference: 'abi:entry:88213',
    observedAt: '2026-09-19T02:11:00.000Z',
    dutyLines: [{ kind: 'DUTY', rawCode: 'DUTY-9901', amount, currency: 'USD' }],
  });
  const truth = computeCustomsDutyTruth(fact);
  const discrepancy = compareCustomsClassification({
    fact,
    expectations: [
      {
        lineRawCode: 'DUTY-9901',
        htsCode: '9901.00.10',
        expectedKind: 'DUTY',
        expectedAmount,
        currency: 'USD',
        source: 'RATE_TABLE',
        reference: 'rate-table:2026-Q3',
      },
    ],
  });
  const assessment = evaluateCustomsEligibility({
    fact,
    truth,
    discrepancy,
    policy: {
      policyId: 'customs-us-2026',
      policyVersion: '1.0.0',
      jurisdiction: 'US',
      allowedSources: ['ABI_VENDOR'],
      maxEntryAgeDays: 365,
      requiredDiscrepancyCodes: ['AMOUNT_MISMATCH'],
      minDisputedAmountByCurrency: { USD: '10.00' },
      allowOtherKindLines: true,
    },
  });
  const estimate = estimateCustomsRecovery({
    fact,
    assessment,
    policy: {
      policyId: 'customs-estimate-2026',
      policyVersion: '1.0.0',
      ratioByCurrency: { USD: '1.00' },
      capByCurrency: { USD: '10000.00' },
      minEstimateByCurrency: { USD: '1.00' },
    },
  });
  return assembleCustomsClaimReadyPackage({
    fact,
    truth,
    discrepancy,
    assessment,
    estimate,
    provenance: { policyId: 'customs-us-2026', policyVersion: '1.0.0', algorithmVersion: 'g4-c7-v1' },
    evidenceReferences: [{ kind: 'ENTRY_DOCUMENT', reference: 'abi:entry:88213', digest: null }],
    computedAt: AT,
  });
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof CustomsHandoffError ? error.code : 'NOT_A_HANDOFF_ERROR';
  }
  return 'NO_ERROR';
}

describe('handoff-only boundary', () => {
  it('CUSTOMER_SELF handoff → manifest/checklist/instructions，且不提交、不外写', () => {
    const artifact = buildCustomsHandoffArtifact({ pkg: readyPackage(), target: 'CUSTOMER_SELF', requestedAt: AT });
    expect(artifact.handoffOnly).toBe(true);
    expect(artifact.supportingDocumentsManifest).toEqual(['ENTRY_DOCUMENT:abi:entry:88213']);
    expect(artifact.checklist.length).toBeGreaterThan(0);
    expect(artifact.filingPerformed).toBe(false);
    expect(artifact.submissionPerformed).toBe(false);
    expect(artifact.externalWritePerformed).toBe(false);
    expect(artifact.transportEnabled).toBe(false);
    expect(artifact.productionCredentials).toBe('ABSENT');
  });

  it('BROKER handoff 必须带 safe broker reference', () => {
    const pkg = readyPackage();
    const withRef = buildCustomsHandoffArtifact({ pkg, target: 'BROKER', brokerReference: 'broker:us-la-01', requestedAt: AT });
    expect(withRef.brokerReference).toBe('broker:us-la-01');
    expect(codeOf(() => buildCustomsHandoffArtifact({ pkg, target: 'BROKER', requestedAt: AT }))).toBe('BROKER_REFERENCE_REQUIRED');
    expect(
      codeOf(() => buildCustomsHandoffArtifact({ pkg, target: 'BROKER', brokerReference: 'ACME Brokers LLC', requestedAt: AT })),
    ).toBe('BROKER_REFERENCE_REQUIRED');
  });

  it('未就绪 package 不得交接；未知 target 拒绝；确定性 handoffId', () => {
    const notReady = readyPackage('80.00', '100.00');
    expect(notReady.readiness).toBe('NOT_READY');
    expect(codeOf(() => buildCustomsHandoffArtifact({ pkg: notReady, target: 'CUSTOMER_SELF', requestedAt: AT }))).toBe(
      'HANDOFF_PACKAGE_NOT_READY',
    );
    expect(codeOf(() => buildCustomsHandoffArtifact({ pkg: readyPackage(), target: 'AUTO_FILING' as never, requestedAt: AT }))).toBe(
      'INVALID_HANDOFF_TARGET',
    );
    const first = buildCustomsHandoffArtifact({ pkg: readyPackage(), target: 'PORTAL_DEEPLINK', requestedAt: AT });
    const second = buildCustomsHandoffArtifact({ pkg: readyPackage(), target: 'PORTAL_DEEPLINK', requestedAt: AT });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.handoffId).toHaveLength(32);
  });

  it('禁止动作清单：自动 filing / broker API write / EDI write / 政府费用支付 / 视 handoff 为追回', () => {
    const artifact = buildCustomsHandoffArtifact({ pkg: readyPackage(), target: 'CUSTOMER_SELF', requestedAt: AT });
    expect(artifact.forbiddenActions).toEqual([...CUSTOMS_HANDOFF_FORBIDDEN_ACTIONS]);
    for (const forbidden of ['AUTO_FILING', 'BROKER_API_WRITE', 'ABI_EDI_WRITE', 'GOVERNMENT_FEE_PAYMENT', 'TREAT_HANDOFF_AS_RECOVERED_TRUTH']) {
      expect(artifact.forbiddenActions).toContain(forbidden);
    }
  });

  it('acknowledgement = 人工记录，绝不等于 filing / recovered truth', () => {
    const ack = normalizeCustomsHandoffAcknowledgement({
      handoffId: 'h'.repeat(32),
      packageId: 'p'.repeat(32),
      actor: 'customer',
      channel: 'portal',
      acknowledgedAt: '2026-10-03T10:05:00.000Z',
      reference: 'portal:ack:9911',
    });
    expect(ack.actor).toBe('CUSTOMER');
    expect(ack.channel).toBe('PORTAL');
    expect(ack.recordedByHuman).toBe(true);
    expect(ack.filingPerformed).toBe(false);
    expect(ack.recoveredTruthDerived).toBe(false);
    expect(ack.externalWritePerformed).toBe(false);
    expect(ack).not.toHaveProperty('submissionResult');
  });

  it('acknowledgement 非法输入 → fail-closed', () => {
    const base = {
      handoffId: 'h'.repeat(32),
      packageId: 'p'.repeat(32),
      actor: 'CUSTOMER',
      channel: 'PORTAL',
      acknowledgedAt: '2026-10-03T10:05:00.000Z',
      reference: 'portal:ack:9911',
    };
    expect(codeOf(() => normalizeCustomsHandoffAcknowledgement(null))).toBe('INVALID_ACKNOWLEDGEMENT');
    expect(codeOf(() => normalizeCustomsHandoffAcknowledgement({ ...base, actor: 'ROBOT' }))).toBe('INVALID_ACKNOWLEDGEMENT');
    expect(codeOf(() => normalizeCustomsHandoffAcknowledgement({ ...base, channel: 'FAX' }))).toBe('INVALID_ACKNOWLEDGEMENT');
    expect(codeOf(() => normalizeCustomsHandoffAcknowledgement({ ...base, acknowledgedAt: '2026-10-03' }))).toBe('INVALID_ACKNOWLEDGEMENT');
    expect(codeOf(() => normalizeCustomsHandoffAcknowledgement({ ...base, reference: 'free text ref' }))).toBe('INVALID_ACKNOWLEDGEMENT');
  });
});
