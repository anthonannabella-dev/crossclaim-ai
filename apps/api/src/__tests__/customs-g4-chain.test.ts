/**
 * CUSTOMS GAP G4 / G7 复核 — C1→C7 全链端到端回归（含非 happy-path fail-closed 传播）。
 * 覆盖：合法链闭环、少缴方向拒绝估算、缺政策阈值 → INDETERMINATE 传播、混币/ PII / 非只读事实 fail-closed、
 *       证据引用 PII 拒绝、链路确定性（packageId/handoffId 可重放）。
 */

import { describe, expect, it } from 'vitest';

import { CustomsEntryContractError, normalizeCustomsEntryFact } from '../services/customs/customs-entry-contract';
import { CustomsDutyTruthError, computeCustomsDutyTruth } from '../services/customs/customs-duty-truth';
import { compareCustomsClassification, CustomsDiscrepancyError } from '../services/customs/customs-classification-discrepancy';
import { evaluateCustomsEligibility } from '../services/customs/customs-recovery-eligibility';
import { CustomsEstimateError, estimateCustomsRecovery } from '../services/customs/customs-recovery-estimate';
import {
  CustomsPackageError,
  assembleCustomsClaimReadyPackage,
  type CustomsClaimReadyPackage,
} from '../services/customs/customs-claim-ready-package';
import { CustomsHandoffError, buildCustomsHandoffArtifact } from '../services/customs/customs-handoff-boundary';

const AT = '2026-10-03T10:05:00.000Z';

const ELIGIBILITY_POLICY = {
  policyId: 'customs-us-2026',
  policyVersion: '1.0.0',
  jurisdiction: 'US',
  allowedSources: ['ABI_VENDOR'] as const,
  maxEntryAgeDays: 365,
  requiredDiscrepancyCodes: ['AMOUNT_MISMATCH'] as const,
  minDisputedAmountByCurrency: { USD: '10.00' },
  allowOtherKindLines: true,
};

const ESTIMATE_POLICY = {
  policyId: 'customs-estimate-2026',
  policyVersion: '1.0.0',
  ratioByCurrency: { USD: '1.00' },
  capByCurrency: { USD: '10000.00' },
  minEstimateByCurrency: { USD: '1.00' },
};

function entryFact(amount = '120.00', extra: Record<string, unknown> = {}) {
  return normalizeCustomsEntryFact({
    entryNumber: 'ABI-2026-000123',
    entryDate: '2026-09-18',
    jurisdiction: 'US',
    portOfEntry: 'Los Angeles, CA',
    importerOfRecordRef: 'ior_acct_88213',
    source: 'ABI_VENDOR',
    rawReference: 'abi:entry:88213',
    observedAt: '2026-09-19T02:11:00.000Z',
    dutyLines: [{ kind: 'DUTY', rawCode: 'DUTY-9901', amount, currency: 'USD' }],
    ...extra,
  });
}

function expectation(expectedAmount = '100.00') {
  return {
    lineRawCode: 'DUTY-9901',
    htsCode: '9901.00.10',
    expectedKind: 'DUTY' as const,
    expectedAmount,
    currency: 'USD',
    source: 'RATE_TABLE' as const,
    reference: 'rate-table:2026-Q3',
  };
}

function runChain(
  amount = '120.00',
  expectedAmount = '100.00',
  eligibilityPolicy: typeof ELIGIBILITY_POLICY = ELIGIBILITY_POLICY,
  evidenceReferences: readonly { kind: 'ENTRY_DOCUMENT'; reference: string; digest: null }[] = [
    { kind: 'ENTRY_DOCUMENT', reference: 'abi:entry:88213', digest: null },
  ],
) {
  const fact = entryFact(amount);
  const truth = computeCustomsDutyTruth(fact);
  const discrepancy = compareCustomsClassification({ fact, expectations: [expectation(expectedAmount)] });
  const assessment = evaluateCustomsEligibility({ fact, truth, discrepancy, policy: eligibilityPolicy as never });
  const estimate = estimateCustomsRecovery({ fact, assessment, policy: ESTIMATE_POLICY });
  const pkg = assembleCustomsClaimReadyPackage({
    fact,
    truth,
    discrepancy,
    assessment,
    estimate,
    provenance: { policyId: 'customs-us-2026', policyVersion: '1.0.0', algorithmVersion: 'g4-chain-v1' },
    evidenceReferences: evidenceReferences as never,
    computedAt: AT,
  });
  return { fact, truth, discrepancy, assessment, estimate, pkg };
}

function handoff(pkg: CustomsClaimReadyPackage, target: 'CUSTOMER_SELF' | 'BROKER' = 'CUSTOMER_SELF', brokerReference?: string) {
  return buildCustomsHandoffArtifact({ pkg, target, brokerReference, requestedAt: AT });
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (
      error instanceof CustomsEntryContractError ||
      error instanceof CustomsDutyTruthError ||
      error instanceof CustomsDiscrepancyError ||
      error instanceof CustomsEstimateError ||
      error instanceof CustomsPackageError ||
      error instanceof CustomsHandoffError
    ) {
      return error.code;
    }
    return 'UNEXPECTED_ERROR';
  }
  return 'NO_ERROR';
}

describe('customs G4 C1→C7 chain', () => {
  it('合法链：C4 ELIGIBLE → C5 估算 20 → C6 READY → C7 handoff（全链零外写）', () => {
    const chain = runChain();
    expect(chain.assessment.status).toBe('ELIGIBLE');
    expect(chain.estimate.byCurrency[0].estimatedAmount).toBe('20.00');
    expect(chain.pkg.readiness).toBe('READY');
    const artifact = handoff(chain.pkg);
    expect(artifact.handoffOnly).toBe(true);
    expect(artifact.filingPerformed).toBe(false);
    expect(artifact.submissionPerformed).toBe(false);
    expect(artifact.externalWritePerformed).toBe(false);
    expect(chain.pkg.billable).toBe(false);
    expect(chain.pkg.estimateOnly).toBe(true);
  });

  it('少缴方向：C4 NOT_ELIGIBLE → C6 NOT_READY → C7 拒绝交接（fail-closed 传播）', () => {
    const chain = runChain('80.00', '100.00');
    expect(chain.assessment.status).toBe('NOT_ELIGIBLE');
    expect(chain.assessment.reasons.map((reason) => reason.code)).toContain('NO_POSITIVE_OVERPAYMENT_DISCREPANCY');
    expect(chain.estimate.status).toBe('NOT_ESTIMATED');
    expect(chain.pkg.readiness).toBe('NOT_READY');
    expect(chain.pkg.gaps).toContain('ESTIMATE_NOT_READY');
    expect(codeOf(() => handoff(chain.pkg))).toBe('HANDOFF_PACKAGE_NOT_READY');
  });

  it('缺政策阈值：C4 INDETERMINATE → C5 INDETERMINATE → C6 缺口 → C7 拒绝', () => {
    const indeterminatePolicy = { ...ELIGIBILITY_POLICY, minDisputedAmountByCurrency: {} };
    const chain = runChain('120.00', '100.00', indeterminatePolicy as never);
    expect(chain.assessment.status).toBe('INDETERMINATE');
    expect(chain.estimate.status).toBe('INDETERMINATE');
    expect(chain.pkg.readiness).toBe('NOT_READY');
    expect(chain.pkg.gaps).toContain('ELIGIBILITY_INDETERMINATE');
    expect(codeOf(() => handoff(chain.pkg))).toBe('HANDOFF_PACKAGE_NOT_READY');
  });

  it('C1 入口 fail-closed：混币与 PII 字段在事实层即被拒绝', () => {
    expect(
      codeOf(() =>
        entryFact('120.00', {
          dutyLines: [
            { kind: 'DUTY', rawCode: 'DUTY-9901', amount: '100.00', currency: 'USD' },
            { kind: 'DUTY', rawCode: 'DUTY-9902', amount: '50.00', currency: 'CAD' },
          ],
        }),
      ),
    ).toBe('MIXED_CURRENCY_DUTY_LINES');
    expect(codeOf(() => entryFact('120.00', { importerName: 'ACME Importers LLC' }))).toBe('RAW_PII_NOT_ALLOWED');
  });

  it('被篡改的事实：C2 起全链 fail-closed（NOT_A_READ_ONLY_FACT）', () => {
    const chain = runChain();
    const tampered = { ...chain.fact, readOnly: false } as unknown as typeof chain.fact;
    expect(codeOf(() => computeCustomsDutyTruth(tampered))).toBe('NOT_A_READ_ONLY_FACT');
    expect(codeOf(() => compareCustomsClassification({ fact: tampered, expectations: [expectation()] }))).toBe('NOT_A_READ_ONLY_FACT');
    expect(codeOf(() => estimateCustomsRecovery({ fact: tampered, assessment: chain.assessment, policy: ESTIMATE_POLICY }))).toBe(
      'NOT_A_READ_ONLY_FACT',
    );
  });

  it('C6 证据引用 PII 拒绝；C7 BROKER 缺 reference 拒绝', () => {
    const chain = runChain();
    expect(
      codeOf(() =>
        assembleCustomsClaimReadyPackage({
          fact: chain.fact,
          truth: chain.truth,
          discrepancy: chain.discrepancy,
          assessment: chain.assessment,
          estimate: chain.estimate,
          provenance: { policyId: 'customs-us-2026', policyVersion: '1.0.0', algorithmVersion: 'g4-chain-v1' },
          evidenceReferences: [{ kind: 'ENTRY_DOCUMENT', reference: 'ACME Importers LLC', digest: null }] as never,
          computedAt: AT,
        }),
      ),
    ).toBe('INVALID_EVIDENCE_REFERENCE');
    expect(codeOf(() => handoff(chain.pkg, 'BROKER'))).toBe('BROKER_REFERENCE_REQUIRED');
  });

  it('链路确定性：两次运行产出相同 packageId / handoffId / 摘要', () => {
    const first = runChain();
    const second = runChain();
    expect(JSON.stringify(second.pkg)).toBe(JSON.stringify(first.pkg));
    expect(handoff(second.pkg).handoffId).toBe(handoff(first.pkg).handoffId);
    expect(first.pkg.resultDigest).toMatch(/^[a-f0-9]{64}$/);
  });
});
