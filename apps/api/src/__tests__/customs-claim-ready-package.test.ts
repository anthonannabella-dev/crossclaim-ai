/**
 * CUSTOMS GAP G4 / C6（Q3 PASS）— Claim-Ready Package 回归。
 * 断言：确定性 packageId/摘要、缺口与清单、只读边界、不提交/不可计费、fail-closed 输入校验、
 *       与 C1–C5 端到端一致性、估算不被固化为可信金额。
 */

import { describe, expect, it } from 'vitest';

import { normalizeCustomsEntryFact, type CustomsEntryFact } from '../services/customs/customs-entry-contract';
import { computeCustomsDutyTruth } from '../services/customs/customs-duty-truth';
import { compareCustomsClassification, type CustomsRateExpectation } from '../services/customs/customs-classification-discrepancy';
import { evaluateCustomsEligibility, type CustomsEligibilityPolicy } from '../services/customs/customs-recovery-eligibility';
import { estimateCustomsRecovery, type CustomsEstimatePolicy } from '../services/customs/customs-recovery-estimate';
import {
  CUSTOMS_PACKAGE_CHECKLIST,
  CustomsPackageError,
  assembleCustomsClaimReadyPackage,
  type CustomsClaimReadyPackageInput,
} from '../services/customs/customs-claim-ready-package';

const COMPUTED_AT = '2026-10-03T09:50:00.000Z';
const ALGORITHM_VERSION = 'g4-c6-v1';

function factOf(amount: string): CustomsEntryFact {
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
  });
}

function expectation(expectedAmount: string): CustomsRateExpectation {
  return {
    lineRawCode: 'DUTY-9901',
    htsCode: '9901.00.10',
    expectedKind: 'DUTY',
    expectedAmount,
    currency: 'USD',
    source: 'RATE_TABLE',
    reference: 'rate-table:2026-Q3',
  };
}

const ELIGIBILITY_POLICY: CustomsEligibilityPolicy = {
  policyId: 'customs-us-2026',
  policyVersion: '1.0.0',
  jurisdiction: 'US',
  allowedSources: ['ABI_VENDOR'],
  maxEntryAgeDays: 365,
  requiredDiscrepancyCodes: ['AMOUNT_MISMATCH'],
  minDisputedAmountByCurrency: { USD: '10.00' },
  allowOtherKindLines: true,
};

const ESTIMATE_POLICY: CustomsEstimatePolicy = {
  policyId: 'customs-estimate-2026',
  policyVersion: '1.0.0',
  ratioByCurrency: { USD: '1.00' },
  capByCurrency: { USD: '10000.00' },
  minEstimateByCurrency: { USD: '1.00' },
};

function fullInput(amount = '120.00', expectedAmount = '100.00', overrides: Partial<CustomsClaimReadyPackageInput> = {}) {
  const fact = factOf(amount);
  const truth = computeCustomsDutyTruth(fact);
  const discrepancy = compareCustomsClassification({ fact, expectations: [expectation(expectedAmount)] });
  const assessment = evaluateCustomsEligibility({ fact, truth, discrepancy, policy: ELIGIBILITY_POLICY });
  const estimate = estimateCustomsRecovery({ fact, assessment, policy: ESTIMATE_POLICY });
  return {
    fact,
    truth,
    discrepancy,
    assessment,
    estimate,
    provenance: { policyId: 'customs-us-2026', policyVersion: '1.0.0', algorithmVersion: ALGORITHM_VERSION },
    evidenceReferences: [
      { kind: 'ENTRY_DOCUMENT', reference: 'abi:entry:88213', digest: null },
      { kind: 'RATE_TABLE', reference: 'rate-table:2026-Q3', digest: 'a'.repeat(64) },
    ],
    computedAt: COMPUTED_AT,
    ...overrides,
  } as CustomsClaimReadyPackageInput;
}

function codeOf(input: unknown): string {
  try {
    assembleCustomsClaimReadyPackage(input as CustomsClaimReadyPackageInput);
  } catch (error) {
    return error instanceof CustomsPackageError ? error.code : 'NOT_A_PACKAGE_ERROR';
  }
  return 'NO_ERROR';
}

describe('assembleCustomsClaimReadyPackage', () => {
  it('ELIGIBLE + ESTIMATED + 证据齐备 → READY，且估算不可计费、不固化', () => {
    const pkg = assembleCustomsClaimReadyPackage(fullInput());
    expect(pkg.readiness).toBe('READY');
    expect(pkg.gaps).toEqual([]);
    expect(pkg.entryNumber).toBe('ABI-2026-000123');
    expect(pkg.dutyTruth.totalByCurrency).toEqual({ USD: '120.00' });
    expect(pkg.eligibility.overpaymentCandidateByCurrency).toEqual({ USD: '20.00' });
    expect(pkg.estimate.byCurrency).toEqual([{ currency: 'USD', estimatedAmount: '20.00' }]);
    expect(pkg.estimate.estimateOnly).toBe(true);
    expect(pkg.estimate.frozenAsTrustedAmount).toBe(false);
    expect(pkg.checklist).toEqual([...CUSTOMS_PACKAGE_CHECKLIST]);
  });

  it('确定性：同一输入两次装配完全一致（含 packageId / 摘要）', () => {
    const first = assembleCustomsClaimReadyPackage(fullInput());
    const second = assembleCustomsClaimReadyPackage(fullInput());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.packageId).toHaveLength(32);
    expect(first.inputDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.resultDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('少缴方向（NOT_ELIGIBLE）→ NOT_READY + 缺口，绝不出现估算金额', () => {
    const pkg = assembleCustomsClaimReadyPackage(fullInput('80.00', '100.00'));
    expect(pkg.readiness).toBe('NOT_READY');
    expect(pkg.gaps).toContain('ELIGIBILITY_NOT_ELIGIBLE');
    expect(pkg.gaps).toContain('ESTIMATE_NOT_READY');
    expect(pkg.estimate.byCurrency).toEqual([]);
    expect(pkg.eligibility.overpaymentCandidateByCurrency).toEqual({});
  });

  it('无证据引用 / 无差异 → 对应缺口码（READY 判定不含糊）', () => {
    const pkg = assembleCustomsClaimReadyPackage(fullInput('120.00', '100.00', { evidenceReferences: [] }));
    expect(pkg.readiness).toBe('NOT_READY');
    expect(pkg.gaps).toContain('NO_EVIDENCE_REFERENCE');
  });

  it('输入不一致（非 ELIGIBLE 却 ESTIMATED）→ PACKAGE_INPUT_INCONSISTENT', () => {
    const base = fullInput();
    const inconsistent = {
      ...base,
      assessment: { ...base.assessment, status: 'NOT_ELIGIBLE' as const },
    };
    expect(codeOf(inconsistent)).toBe('PACKAGE_INPUT_INCONSISTENT');
  });

  it('provenance 缺失 / 证据引用非法 → fail-closed', () => {
    const base = fullInput();
    expect(codeOf({ ...base, provenance: { policyId: '', policyVersion: '1.0.0', algorithmVersion: ALGORITHM_VERSION } })).toBe(
      'INVALID_PROVENANCE',
    );
    expect(
      codeOf({ ...base, evidenceReferences: [{ kind: 'ENTRY_DOCUMENT', reference: 'ACME Importers LLC', digest: null }] }),
    ).toBe('INVALID_EVIDENCE_REFERENCE');
    expect(
      codeOf({ ...base, evidenceReferences: [{ kind: 'ENTRY_DOCUMENT', reference: 'ok-ref', digest: 'not-hex' }] }),
    ).toBe('INVALID_EVIDENCE_REFERENCE');
    expect(codeOf({ ...base, evidenceReferences: [{ kind: 'UNKNOWN', reference: 'ok-ref', digest: null }] })).toBe(
      'INVALID_EVIDENCE_REFERENCE',
    );
  });

  it('非只读事实 / 非法子报告 → fail-closed', () => {
    const base = fullInput();
    expect(codeOf({ ...base, fact: { ...base.fact, readOnly: false } })).toBe('NOT_A_READ_ONLY_FACT');
    expect(codeOf({ ...base, fact: null })).toBe('NOT_A_READ_ONLY_FACT');
    expect(codeOf({ ...base, truth: null })).toBe('INVALID_TRUTH');
    expect(codeOf({ ...base, discrepancy: null })).toBe('INVALID_DISCREPANCY_REPORT');
    expect(codeOf({ ...base, assessment: null })).toBe('INVALID_ASSESSMENT');
    expect(codeOf({ ...base, estimate: { ...base.estimate, billable: true } })).toBe('INVALID_ESTIMATE');
  });

  it('边界：不 filing / 不提交 / 不可计费 / 无 recovered truth', () => {
    const pkg = assembleCustomsClaimReadyPackage(fullInput());
    expect(pkg.filingPerformed).toBe(false);
    expect(pkg.submissionPerformed).toBe(false);
    expect(pkg.transportEnabled).toBe(false);
    expect(pkg.estimateOnly).toBe(true);
    expect(pkg.billable).toBe(false);
    expect(pkg.productionCredentials).toBe('ABSENT');
    expect(pkg).not.toHaveProperty('recoveredAmount');
    expect(pkg).not.toHaveProperty('submissionResult');
  });
});
