/**
 * CUSTOMS GAP G4 / C6（MASTER GAP CLOSURE · 架构方 Q3 = PASS）— Claim-Ready Package（确定性装配）。
 * ---------------------------------------------------------------
 * 输入：C1 事实 + C2 duty 真值 + C3 差异 + C4 资格 + C5 估算 + 政策/算法版本 + 证据引用。
 * 输出：**确定性**可提交包（含清单与缺口），供 C7 handoff 使用。
 *
 * 硬边界（架构方 Q3 明文）：
 *   · filingPerformed=false / submissionPerformed=false / transportEnabled=false。
 *   · estimateOnly=true / billable=false：包内估算**不是**可信金额，也不是账单基数。
 *   · 不生成任何 recovered truth；不调用任何外部系统（无端口/无网络/无 DB）。
 *   · 确定性与可重放：inputDigest / resultDigest / packageId 由规范化 JSON 的 sha256 派生，clock 由调用方注入。
 */

import { createHash } from 'node:crypto';

import type { CustomsEntryFact } from './customs-entry-contract';
import { assertReadOnlyEntryFact, CustomsDutyTruthError, type CustomsDutyTruth } from './customs-duty-truth';
import type { CustomsClassificationDiscrepancyReport } from './customs-classification-discrepancy';
import type { CustomsEligibilityAssessment } from './customs-recovery-eligibility';
import type { CustomsRecoveryEstimate } from './customs-recovery-estimate';

export const CUSTOMS_EVIDENCE_REFERENCE_KINDS = [
  'ENTRY_DOCUMENT',
  'DUTY_LINE_STATEMENT',
  'BROKER_QUOTE',
  'RATE_TABLE',
  'USER_UPLOAD',
  'OTHER',
] as const;
export type CustomsEvidenceReferenceKind = (typeof CUSTOMS_EVIDENCE_REFERENCE_KINDS)[number];

export interface CustomsEvidenceReference {
  kind: CustomsEvidenceReferenceKind;
  /** machine-safe reference（禁止空格/自由文本/PII）。 */
  reference: string;
  digest: string | null;
}

export const CUSTOMS_PACKAGE_GAPS = [
  'ELIGIBILITY_NOT_ELIGIBLE',
  'ELIGIBILITY_INDETERMINATE',
  'ESTIMATE_NOT_READY',
  'NO_EVIDENCE_REFERENCE',
  'NO_DISCREPANCY_EVIDENCE',
] as const;
export type CustomsPackageGap = (typeof CUSTOMS_PACKAGE_GAPS)[number];

export const CUSTOMS_PACKAGE_CHECKLIST = [
  'ENTRY_FACT_SNAPSHOT',
  'DUTY_TRUTH_BREAKDOWN',
  'DISCREPANCY_EVIDENCE',
  'ELIGIBILITY_DETERMINATION',
  'ESTIMATE_PREVIEW',
  'POLICY_PROVENANCE',
  'SUPPORTING_DOCUMENTS_MANIFEST',
] as const;
export type CustomsPackageChecklistItem = (typeof CUSTOMS_PACKAGE_CHECKLIST)[number];

export const CUSTOMS_PACKAGE_ERROR_CODES = [
  'NOT_A_READ_ONLY_FACT',
  'INVALID_TRUTH',
  'INVALID_DISCREPANCY_REPORT',
  'INVALID_ASSESSMENT',
  'INVALID_ESTIMATE',
  'INVALID_PROVENANCE',
  'INVALID_EVIDENCE_REFERENCE',
  'PACKAGE_INPUT_INCONSISTENT',
] as const;
export type CustomsPackageErrorCode = (typeof CUSTOMS_PACKAGE_ERROR_CODES)[number];

export class CustomsPackageError extends Error {
  readonly code: CustomsPackageErrorCode;
  readonly path: string;

  constructor(code: CustomsPackageErrorCode, fieldPath: string, detail: string) {
    super(code + ' @ ' + fieldPath + ': ' + detail);
    this.name = 'CustomsPackageError';
    this.code = code;
    this.path = fieldPath;
  }
}

export interface CustomsPackageProvenance {
  /** C4/C5 政策型投影必须带 policyId + policyVersion。 */
  policyId: string;
  policyVersion: string;
  /** 算法版本：仅靠 policyVersion 无法解释旧结果。 */
  algorithmVersion: string;
}

export interface CustomsClaimReadyPackageInput {
  fact: CustomsEntryFact;
  truth: CustomsDutyTruth;
  discrepancy: CustomsClassificationDiscrepancyReport;
  assessment: CustomsEligibilityAssessment;
  estimate: CustomsRecoveryEstimate;
  provenance: CustomsPackageProvenance;
  evidenceReferences: readonly CustomsEvidenceReference[];
  /** 由调用方注入，保证确定性可重放。 */
  computedAt: string;
}

export interface CustomsClaimReadyPackage {
  packageId: string;
  entryNumber: string;
  jurisdiction: string;
  readiness: 'READY' | 'NOT_READY';
  gaps: readonly CustomsPackageGap[];
  checklist: readonly CustomsPackageChecklistItem[];
  dutyTruth: {
    currencies: readonly string[];
    totalByCurrency: Readonly<Record<string, string>>;
    observations: readonly string[];
  };
  discrepancy: {
    itemCount: number;
    codes: readonly string[];
    signedByCurrency: Readonly<Record<string, string>>;
  };
  eligibility: {
    status: CustomsEligibilityAssessment['status'];
    reasons: readonly string[];
    overpaymentCandidateByCurrency: Readonly<Record<string, string>>;
  };
  estimate: {
    status: CustomsRecoveryEstimate['status'];
    byCurrency: readonly { currency: string; estimatedAmount: string }[];
    estimateOnly: true;
    frozenAsTrustedAmount: false;
  };
  evidenceReferences: readonly CustomsEvidenceReference[];
  provenance: CustomsPackageProvenance;
  inputDigest: string;
  resultDigest: string;
  computedAt: string;
  readonly filingPerformed: false;
  readonly submissionPerformed: false;
  readonly transportEnabled: false;
  readonly estimateOnly: true;
  readonly billable: false;
  readonly productionCredentials: 'ABSENT';
}

const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9._:@#/-]{1,96}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

function fail(code: CustomsPackageErrorCode, fieldPath: string, detail: string): never {
  throw new CustomsPackageError(code, fieldPath, detail);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map((item) => canonical(item)).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key]));
    return '{' + entries.join(',') + '}';
  }
  return JSON.stringify(value ?? null);
}

function sha256Hex(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function requireText(value: unknown, fieldPath: string, maxLength: number, code: CustomsPackageErrorCode): string {
  if (typeof value !== 'string') fail(code, fieldPath, 'expected a string');
  const trimmed = value.trim();
  if (trimmed.length === 0) fail(code, fieldPath, 'expected a non-empty string');
  if (trimmed.length > maxLength) fail(code, fieldPath, 'value too long');
  return trimmed;
}

function normalizeProvenance(value: unknown): CustomsPackageProvenance {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('INVALID_PROVENANCE', 'provenance', 'expected a plain object');
  }
  const record = value as Record<string, unknown>;
  return {
    policyId: requireText(record.policyId, 'provenance.policyId', 64, 'INVALID_PROVENANCE'),
    policyVersion: requireText(record.policyVersion, 'provenance.policyVersion', 64, 'INVALID_PROVENANCE'),
    algorithmVersion: requireText(record.algorithmVersion, 'provenance.algorithmVersion', 64, 'INVALID_PROVENANCE'),
  };
}

function normalizeEvidenceReferences(value: unknown): readonly CustomsEvidenceReference[] {
  if (!Array.isArray(value)) fail('INVALID_EVIDENCE_REFERENCE', 'evidenceReferences', 'expected an array');
  return value.map((raw, index) => {
    const fieldPath = 'evidenceReferences[' + index + ']';
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      fail('INVALID_EVIDENCE_REFERENCE', fieldPath, 'expected a plain object');
    }
    const record = raw as Record<string, unknown>;
    const kind = requireText(record.kind, fieldPath + '.kind', 32, 'INVALID_EVIDENCE_REFERENCE').toUpperCase();
    if (!(CUSTOMS_EVIDENCE_REFERENCE_KINDS as readonly string[]).includes(kind)) {
      fail('INVALID_EVIDENCE_REFERENCE', fieldPath + '.kind', 'unknown evidence reference kind');
    }
    const reference = requireText(record.reference, fieldPath + '.reference', 96, 'INVALID_EVIDENCE_REFERENCE');
    if (!SAFE_REFERENCE_PATTERN.test(reference)) {
      fail('INVALID_EVIDENCE_REFERENCE', fieldPath + '.reference', 'reference must be machine-safe (no spaces / free text / PII)');
    }
    let digest: string | null = null;
    if (record.digest !== undefined && record.digest !== null) {
      const digestText = requireText(record.digest, fieldPath + '.digest', 64, 'INVALID_EVIDENCE_REFERENCE');
      if (!DIGEST_PATTERN.test(digestText)) fail('INVALID_EVIDENCE_REFERENCE', fieldPath + '.digest', 'digest must be hex64');
      digest = digestText;
    }
    return { kind: kind as CustomsEvidenceReferenceKind, reference, digest };
  });
}

/**
 * 装配 claim-ready package（确定性、无提交、无外写）。
 */
export function assembleCustomsClaimReadyPackage(input: CustomsClaimReadyPackageInput): CustomsClaimReadyPackage {
  const fact = input?.fact;
  try {
    assertReadOnlyEntryFact(fact);
  } catch (error) {
    if (error instanceof CustomsDutyTruthError) fail('NOT_A_READ_ONLY_FACT', error.path, error.message);
    throw error;
  }
  const truth = input?.truth;
  if (!truth || !Array.isArray(truth.currencies) || truth.filingPerformed !== false) {
    fail('INVALID_TRUTH', 'truth', 'expected a customs duty truth');
  }
  const discrepancy = input?.discrepancy;
  if (!discrepancy || !Array.isArray(discrepancy.items)) {
    fail('INVALID_DISCREPANCY_REPORT', 'discrepancy', 'expected a discrepancy report');
  }
  const assessment = input?.assessment;
  if (!assessment || typeof assessment.status !== 'string' || !assessment.overpaymentCandidateAmountByCurrency) {
    fail('INVALID_ASSESSMENT', 'assessment', 'expected a customs eligibility assessment');
  }
  const estimate = input?.estimate;
  if (!estimate || typeof estimate.status !== 'string' || !Array.isArray(estimate.byCurrency)) {
    fail('INVALID_ESTIMATE', 'estimate', 'expected a customs recovery estimate');
  }
  if (estimate.billable !== false || estimate.finalAmountDerived !== false) {
    fail('INVALID_ESTIMATE', 'estimate', 'estimate must remain non-billable and non-final');
  }
  if (assessment.status !== 'ELIGIBLE' && estimate.status === 'ESTIMATED') {
    fail('PACKAGE_INPUT_INCONSISTENT', 'estimate', 'estimate cannot be ESTIMATED when eligibility is not ELIGIBLE');
  }
  const provenance = normalizeProvenance(input.provenance);
  const evidenceReferences = normalizeEvidenceReferences(input.evidenceReferences);
  const computedAt = requireText(input.computedAt, 'computedAt', 40, 'INVALID_PROVENANCE');

  const gaps: CustomsPackageGap[] = [];
  if (assessment.status === 'NOT_ELIGIBLE') gaps.push('ELIGIBILITY_NOT_ELIGIBLE');
  if (assessment.status === 'INDETERMINATE') gaps.push('ELIGIBILITY_INDETERMINATE');
  if (estimate.status !== 'ESTIMATED') gaps.push('ESTIMATE_NOT_READY');
  if (evidenceReferences.length === 0) gaps.push('NO_EVIDENCE_REFERENCE');
  if (discrepancy.items.length === 0) gaps.push('NO_DISCREPANCY_EVIDENCE');

  const totalByCurrency: Record<string, string> = {};
  for (const entry of truth.currencies) totalByCurrency[entry.currency] = entry.totalAmount;

  const body = {
    entryNumber: fact.entryNumber,
    jurisdiction: fact.jurisdiction,
    dutyTruth: {
      currencies: truth.currencies.map((entry) => entry.currency).sort(),
      totalByCurrency,
      observations: [...truth.observations],
    },
    discrepancy: {
      itemCount: discrepancy.items.length,
      codes: [...new Set(discrepancy.items.map((item) => item.code))].sort(),
      signedByCurrency: assessment.signedDiscrepancyAmountByCurrency,
    },
    eligibility: {
      status: assessment.status,
      reasons: assessment.reasons.map((reason) => reason.code),
      overpaymentCandidateByCurrency: assessment.overpaymentCandidateAmountByCurrency,
    },
    estimate: {
      status: estimate.status,
      byCurrency: estimate.byCurrency.map((entry) => ({ currency: entry.currency, estimatedAmount: entry.estimatedAmount })),
      estimateOnly: true as const,
      frozenAsTrustedAmount: false as const,
    },
    evidenceReferences,
    provenance,
    computedAt,
    checklist: [...CUSTOMS_PACKAGE_CHECKLIST],
    gaps,
  };

  const inputDigest = sha256Hex({
    entryNumber: fact.entryNumber,
    entryDate: fact.entryDate,
    observedAt: fact.observedAt,
    dutyLines: fact.dutyLines,
    totalDutyAmountByCurrency: fact.totalDutyAmountByCurrency,
    provenance,
    evidenceReferences,
  });
  const resultDigest = sha256Hex(body);

  return {
    packageId: sha256Hex({ inputDigest, resultDigest }).slice(0, 32),
    entryNumber: fact.entryNumber,
    jurisdiction: fact.jurisdiction,
    readiness: gaps.length === 0 ? 'READY' : 'NOT_READY',
    gaps,
    checklist: [...CUSTOMS_PACKAGE_CHECKLIST],
    dutyTruth: body.dutyTruth,
    discrepancy: body.discrepancy,
    eligibility: body.eligibility,
    estimate: body.estimate,
    evidenceReferences,
    provenance,
    inputDigest,
    resultDigest,
    computedAt,
    filingPerformed: false,
    submissionPerformed: false,
    transportEnabled: false,
    estimateOnly: true,
    billable: false,
    productionCredentials: 'ABSENT',
  };
}
